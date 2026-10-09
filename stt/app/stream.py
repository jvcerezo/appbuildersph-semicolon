"""One audio stream from a backend, transcribed by the best engine available.

Protocol on /ws/stream:

    -> {"type": "start", "offset_seconds": X}   then binary PCM s16le mono 16 kHz
    -> {"type": "stop"}                          flush and finish
    -> {"type": "simulate_offline", "on": bool}  demo/test: act as if the internet is gone
    <- {"type": "transcript", "text", "start", "end", "final", "engine"}
    <- {"type": "status", "state", "engine", "message"}
    <- {"type": "done"}

Same transcript format as /ws/session. A non-final line is the line still
being spoken: it is replaced by later non-final lines and then by its final.

Engine choice follows STT_MODE, like the test page:
  auto        Soniox if it is reachable and a key is set, else local
  soniox      Soniox first, local only as a fallback
  local       local engine only (cloud not used, but allowed)
  local_only  local engine only, never contacts the cloud

If Soniox drops mid-stream we keep what it finalised, replay the last few
seconds of audio into the local engine and carry on. In auto/soniox mode we
then probe the internet every 5-60 s and hand back to Soniox when it returns.
Times are absolute (offset_seconds + audio position) across every switch.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable

from .config import Settings
from .local_engine import LocalSTTEngine, TranscriptEvent
from .session import SessionHub
from .soniox_stream import SonioxStream, SonioxUnavailable

log = logging.getLogger("linaw.stream")

SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2
RING_SECONDS = 20  # audio kept for replay when switching engines
LOCAL_REPLAY_MAX_S = 6  # replay at most this much into the local engine, so it catches up fast
REPLAY_CHUNK = BYTES_PER_SECOND // 10
RETRY_MIN_S, RETRY_MAX_S = 5, 60

Send = Callable[[dict], Awaitable[None]]
Probe = Callable[[], Awaitable[bool]]


class StreamSession:
    def __init__(
        self, settings: Settings, engine: LocalSTTEngine | None, hub: SessionHub, online: Probe, send: Send
    ) -> None:
        self.settings = settings
        self.engine = engine
        self.hub = hub
        self.online = online
        self.send = send
        self.offset = 0.0
        self.received = 0  # bytes of PCM since start
        self.ring = bytearray()
        self.ring_start = 0.0  # session time of ring[0]
        self.last_final_end = 0.0
        self.soniox: SonioxStream | None = None
        self.local_sid: str | None = None
        self.started = False
        self.stopping = False
        self.simulated_offline = False
        self._retry: asyncio.Task | None = None
        self._switch = asyncio.Lock()

    # ------------------------------------------------------------ public

    @property
    def wants_cloud(self) -> bool:
        s = self.settings
        return s.cloud_allowed and s.soniox_configured and s.stt_mode in ("auto", "soniox")

    @property
    def engine_name(self) -> str:
        return "soniox" if self.soniox else "local" if self.local_sid else "none"

    def now(self) -> float:
        return self.offset + self.received / BYTES_PER_SECOND

    async def start(self, offset: float) -> None:
        self.offset = self.ring_start = self.last_final_end = offset
        self.started = True
        if self.wants_cloud and (self.settings.stt_mode == "soniox" or await self._is_online()):
            try:
                async with self._switch:
                    await self._open_soniox(offset)
                await self._status("listening", "")
                return
            except SonioxUnavailable as e:
                await self._fall_back(str(e), e.retryable)
                return
        why = "no internet" if self.wants_cloud else ""
        if await self._open_local(offset):
            await self._status("listening", why)
            if self.wants_cloud:
                self._schedule_return()

    async def push(self, pcm: bytes) -> None:
        if not self.started or self.stopping:
            return
        self.ring += pcm
        self.received += len(pcm)
        excess = len(self.ring) - RING_SECONDS * BYTES_PER_SECOND
        if excess > 0:
            excess -= excess % 2
            del self.ring[:excess]
            self.ring_start += excess / BYTES_PER_SECOND
        if self.soniox:
            self.soniox.push_audio(pcm)
        elif self.local_sid and self.engine:
            await self.engine.push_audio(self.local_sid, pcm)

    async def simulate_offline(self, on: bool) -> None:
        """Demo the fallback: drop Soniox now and refuse to go back until switched off."""
        self.simulated_offline = on
        if on and self.soniox:
            await self._fall_back("simulated offline", True)

    async def _is_online(self) -> bool:
        return not self.simulated_offline and await self.online()

    async def stop(self, flush: bool = True) -> None:
        if self.stopping:
            return
        self.stopping = True
        if self._retry:
            self._retry.cancel()
        async with self._switch:
            if self.soniox:
                soniox, self.soniox = self.soniox, None
                await soniox.close(flush=flush)
            if self.local_sid and self.engine:
                sid, self.local_sid = self.local_sid, None
                await self.engine.end_session(sid, flush=flush)

    # ------------------------------------------------------------ engines

    async def _on_event(self, ev: TranscriptEvent) -> None:
        if ev.final:
            self.last_final_end = max(self.last_final_end, ev.end)
            await self.hub.add_final(ev.text, ev.start, ev.end, ev.engine)
        else:
            await self.hub.add_partial(ev.text, ev.start, ev.end, ev.engine)
        await self.send(
            {
                "type": "transcript",
                "text": " ".join(ev.text.split()),
                "start": round(ev.start, 2),
                "end": round(max(ev.end, ev.start), 2),
                "final": ev.final,
                "engine": ev.engine,
            }
        )

    def _replay_from(self, since: float) -> bytes:
        index = max(0, int((since - self.ring_start) * SAMPLE_RATE)) * 2
        return bytes(self.ring[index:])

    async def _open_soniox(self, since: float) -> None:
        stream = SonioxStream(self.settings, since, self._on_event, self._on_soniox_lost)
        await stream.open()
        stream.last_final_end = self.last_final_end
        audio = self._replay_from(since)
        for i in range(0, len(audio), REPLAY_CHUNK):
            stream.push_audio(audio[i : i + REPLAY_CHUNK])
        self.soniox = stream
        log.info("Soniox stream open at %.1f s (%.1f s replayed)", since, len(audio) / BYTES_PER_SECOND)

    async def _open_local(self, since: float) -> bool:
        if self.engine is None:
            await self._status("error", "No speech engine: Soniox is unavailable and the local engine is not loaded")
            return False
        sid = uuid.uuid4().hex[:8]

        async def on_stats(_stats: dict) -> None:
            pass

        async def on_warning(message: str) -> None:
            await self._status("processing", message)

        await self.engine.start_session(sid, since, self._on_event, on_stats, on_warning)
        self.local_sid = sid
        audio = self._replay_from(since)
        for i in range(0, len(audio), REPLAY_CHUNK):
            await self.engine.push_audio(sid, audio[i : i + REPLAY_CHUNK])
        log.info("local session %s open at %.1f s (%.1f s replayed)", sid, since, len(audio) / BYTES_PER_SECOND)
        return True

    async def _on_soniox_lost(self, reason: str, retryable: bool) -> None:
        asyncio.ensure_future(self._fall_back(reason, retryable))

    async def _fall_back(self, reason: str, retryable: bool) -> None:
        async with self._switch:
            if self.stopping:
                return
            if self.soniox:
                soniox, self.soniox = self.soniox, None
                await soniox.abandon()  # commits what Soniox already finalised
            if self.local_sid:
                return
            since = max(self.last_final_end, self.now() - LOCAL_REPLAY_MAX_S)
            if await self._open_local(since):
                await self._status("offline", f"Switched to local Whisper: {reason}")
        if retryable and self.wants_cloud:
            self._schedule_return()

    def _schedule_return(self) -> None:
        if self._retry is None or self._retry.done():
            self._retry = asyncio.create_task(self._return_to_soniox())

    async def _return_to_soniox(self) -> None:
        delay = RETRY_MIN_S
        while not self.stopping and self.local_sid:
            await asyncio.sleep(delay)
            if self.stopping or not await self._is_online():
                delay = min(delay * 2, RETRY_MAX_S)
                continue
            async with self._switch:
                if self.stopping or not self.local_sid:
                    return
                try:
                    await self._open_soniox(self.last_final_end)
                except SonioxUnavailable as e:
                    log.info("Soniox still unavailable: %s", e)
                    if not e.retryable:
                        return
                    delay = min(delay * 2, RETRY_MAX_S)
                    continue
                # Soniox re-transcribes from the last final, so drop the local engine's unfinished line.
                sid, self.local_sid = self.local_sid, None
                if self.engine:
                    await self.engine.end_session(sid, flush=False)
            await self._status("listening", "Back online: switched to Soniox")
            return

    async def _status(self, state: str, message: str) -> None:
        engine = self.engine_name
        await self.hub.status(state, engine if engine != "none" else "local", message)
        await self.send({"type": "status", "state": state, "engine": engine, "message": message})
