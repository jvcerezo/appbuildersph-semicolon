"""Soniox real-time transcription, driven from the server.

The test page talks to Soniox from the browser with a temporary key. Linaw's
backend streams audio here instead, so the long-lived key is used in this
process only and never reaches the UI.

    stream = SonioxStream(settings, offset_seconds, on_event, on_lost)
    await stream.open()                 # raises SonioxUnavailable
    stream.push_audio(pcm_s16le_16k)    # 100 ms chunks or so
    await stream.close()                # flushes the last final

Token handling matches the test page: final tokens accumulate into a segment
that closes at Soniox's <end> endpoint marker or after ~8 s at a word
boundary; final + non-final tokens make the live (partial) line.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, WebSocketException

from .config import Settings, load_stt_terms
from .local_engine import EventFn, TranscriptEvent

log = logging.getLogger("linaw.soniox")

DOMAIN_CONTEXT = "Philippine impeachment trial / Senate hearing"
SEGMENT_MAX_S = 8.0  # close a segment after this long without an endpoint
PARTIAL_EVERY_S = 0.15  # coalesce partial updates
STALL_S = 5.0  # no message from Soniox for this long while sending audio: treat as lost
KEEPALIVE_S = 10.0  # Soniox needs traffic at least every 20 s

# reason, retryable (False when retrying would fail the same way, e.g. a rejected key)
LostFn = Callable[[str, bool], Awaitable[None]]


class SonioxUnavailable(Exception):
    def __init__(self, reason: str, retryable: bool = True) -> None:
        super().__init__(reason)
        self.retryable = retryable


def start_config(settings: Settings) -> dict:
    return {
        "api_key": settings.soniox_api_key,
        "model": settings.soniox_model,
        "audio_format": "pcm_s16le",
        "sample_rate": 16000,
        "num_channels": 1,
        "language_hints": settings.soniox_language_hints,
        "enable_endpoint_detection": True,
        "context": {
            "general": [{"key": "domain", "value": DOMAIN_CONTEXT}],
            "terms": load_stt_terms(settings),
        },
    }


def _describe_error(message: dict) -> tuple[str, bool]:
    code = str(message.get("error_code", message.get("error_type", "")))
    reason = {
        "401": "Soniox rejected the API key (401)",
        "402": "Soniox account has no credit left (402)",
        "429": "Soniox rate or concurrency limit reached (429)",
    }.get(code, f"Soniox error {code}")
    if message.get("error_message"):
        reason += f": {message['error_message']}"
    return reason, code not in ("401", "402")


class SonioxStream:
    def __init__(self, settings: Settings, offset_seconds: float, on_event: EventFn, on_lost: LostFn) -> None:
        self.settings = settings
        self.offset = offset_seconds
        self.on_event = on_event
        self.on_lost = on_lost
        self.last_final_end = offset_seconds
        self.bytes_sent = 0
        self._ws: ClientConnection | None = None
        self._final: list[dict] = []
        self._non_final: list[dict] = []
        self._last_partial = ""
        self._partial_due: asyncio.TimerHandle | None = None
        self._final_proc_ms = 0
        self._last_message = time.monotonic()
        self._last_send = time.monotonic()
        self._finished = asyncio.Event()
        self._closing = False
        self._lost = False
        self._tasks: list[asyncio.Task] = []

    async def open(self) -> None:
        try:
            self._ws = await connect(self.settings.soniox_ws_url, open_timeout=5, max_size=2**22)
            await self._ws.send(json.dumps(start_config(self.settings)))
        except (OSError, asyncio.TimeoutError, WebSocketException) as e:
            raise SonioxUnavailable(f"could not reach Soniox ({type(e).__name__})") from None
        self._last_message = time.monotonic()
        self._tasks = [asyncio.create_task(self._read()), asyncio.create_task(self._watch())]

    def push_audio(self, pcm: bytes) -> None:
        if self._ws is None or self._closing or self._lost:
            return
        self.bytes_sent += len(pcm)
        self._last_send = time.monotonic()
        asyncio.ensure_future(self._send(pcm))

    async def close(self, flush: bool = True) -> None:
        """flush=True waits for Soniox to finalise what it has heard."""
        self._closing = True
        if self._ws is not None and flush and not self._lost:
            try:
                await self._ws.send("")  # empty frame = end of audio
                await asyncio.wait_for(self._finished.wait(), timeout=4)
            except (ConnectionClosed, asyncio.TimeoutError):
                pass
        if flush:
            await self._flush()
        await self._shutdown()

    async def abandon(self) -> None:
        """Drop the stream at once, keeping only what Soniox already finalised."""
        self._closing = True
        await self._flush()
        await self._shutdown()

    async def _shutdown(self) -> None:
        if self._partial_due:
            self._partial_due.cancel()
        for task in self._tasks:
            if task is not asyncio.current_task():
                task.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass

    async def _send(self, data: bytes | str) -> None:
        try:
            await self._ws.send(data)  # type: ignore[union-attr]
        except ConnectionClosed:
            pass  # the reader reports the close

    async def _lose(self, reason: str, retryable: bool) -> None:
        if self._lost or self._closing:
            return
        self._lost = True
        log.warning("Soniox lost: %s", reason)
        await self.on_lost(reason, retryable)

    async def _read(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                self._last_message = time.monotonic()
                try:
                    message = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                if message.get("error_code") is not None or message.get("error_type"):
                    reason, retryable = _describe_error(message)
                    await self._lose(reason, retryable)
                    return
                await self._on_tokens(message)
                if message.get("finished"):
                    self._finished.set()
        except ConnectionClosed as e:
            self._finished.set()
            await self._lose(f"Soniox connection closed (code {e.code})", True)
            return
        self._finished.set()
        if not self._closing:
            await self._lose("Soniox ended the stream", True)

    async def _watch(self) -> None:
        """Notice a dead network (often no close event) and keep the stream alive in pauses."""
        while True:
            await asyncio.sleep(1)
            now = time.monotonic()
            if now - self._last_send < 2 and now - self._last_message > STALL_S:
                await self._lose("Soniox stopped answering (internet lost?)", True)
                return
            if now - self._last_send > KEEPALIVE_S:
                await self._send(json.dumps({"type": "keepalive"}))
                self._last_send = now

    async def _on_tokens(self, message: dict) -> None:
        non_final = []
        for token in message.get("tokens") or []:
            text = token.get("text", "")
            if token.get("is_final"):
                if text == "<end>":
                    await self._flush()
                    continue
                if self._final and text[:1].isspace() and self._segment_length() >= SEGMENT_MAX_S:
                    await self._flush()
                self._final.append(token)
            elif text != "<end>":
                non_final.append(token)
        self._non_final = non_final
        if message.get("final_audio_proc_ms") is not None:
            self._final_proc_ms = message["final_audio_proc_ms"]
        if self._partial_due is None:
            loop = asyncio.get_running_loop()
            self._partial_due = loop.call_later(PARTIAL_EVERY_S, lambda: asyncio.ensure_future(self._partial()))

    def _segment_length(self) -> float:
        first, last = self._final[0].get("start_ms"), self._final[-1].get("end_ms")
        return (last - first) / 1000 if first is not None and last is not None else 0.0

    def _span(self, tokens: list[dict]) -> tuple[float, float]:
        first, last = tokens[0].get("start_ms"), tokens[-1].get("end_ms")
        start = self.offset + first / 1000 if first is not None else self.last_final_end
        end = self.offset + last / 1000 if last is not None else max(start, self.offset + self._final_proc_ms / 1000)
        return start, end

    async def _flush(self) -> None:
        if not self._final:
            return
        tokens, self._final = self._final, []
        text = "".join(t.get("text", "") for t in tokens).strip()
        if not text:
            return
        start, end = self._span(tokens)
        self.last_final_end = max(self.last_final_end, end)
        self._last_partial = ""
        await self.on_event(TranscriptEvent(text, start, end, final=True, engine="soniox"))

    async def _partial(self) -> None:
        self._partial_due = None
        if self._closing or self._lost:
            return
        tokens = self._final + self._non_final
        text = "".join(t.get("text", "") for t in tokens).strip()
        if text == self._last_partial:
            return
        self._last_partial = text
        start, end = self._span(tokens) if tokens else (self.last_final_end, self.last_final_end)
        await self.on_event(TranscriptEvent(text, start, end, final=False, engine="soniox"))
