"""WhisperLiveKit local engine: real-time partial text, fully offline.

Integration (see README "WhisperLiveKit integration"):
  * Embedded (WLK_EMBEDDED=true, default): one shared TranscriptionEngine is
    loaded at startup inside our FastAPI process; every /ws/stt-local session
    gets its own AudioProcessor. Audio goes in as raw PCM s16le 16 kHz
    (pcm_input=True), so FFmpeg is not needed.
  * Subprocess (WLK_EMBEDDED=false): `python -m app.wlk_server` runs
    WhisperLiveKit's own server on 127.0.0.1:WLK_PORT and each session proxies
    to its /asr WebSocket.

Offline guarantees: models are resolved from WLK_MODEL_CACHE_DIR only (the
SimulStreaming decoder .pt and the faster-whisper encoder), the warm-up uses a
local file (WhisperLiveKit's default warm-up downloads jfk.wav), and the server
sets HF_HUB_OFFLINE=1.

Mapping to the Linaw contract (CommitSegmenter):
  committed tokens -> grouped into segments; a segment closes at a silence,
                      at sentence-ending punctuation, or after ~8 s at a word
                      boundary, and is then sent with final=true
  open segment + WhisperLiveKit's unvalidated buffer -> final=false (partial)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .config import ROOT_DIR, Settings
from .local_engine import EventFn, LocalSTTEngine, StatsFn, TranscriptEvent, WarnFn
from .local_stt import SAMPLE_RATE, ModelUnavailableError, cuda_usable

log = logging.getLogger("linaw.wlk")

BYTES_PER_SECOND = SAMPLE_RATE * 2
SEGMENT_MAX_SECONDS = 8.0
SENTENCE_END = (".", "?", "!")
MIN_SENTENCE_WORDS = 3
# Backlog guard: past MAX, incoming audio is replaced by silence (the VAD skips
# it cheaply, timestamps stay continuous) until the backlog is under RESUME.
MAX_BACKLOG_SECONDS = 8.0
RESUME_BACKLOG_SECONDS = 3.0
RETENTION_SECONDS = 300  # WhisperLiveKit history kept per session (bounded memory)


# ---------------------------------------------------------------- contract mapping
@dataclass
class _Piece:
    text: str
    start: float  # seconds, relative to the engine session
    end: float


class CommitSegmenter:
    """Turns committed WhisperLiveKit text into final segments and the live
    partial. All times passed in are relative; events carry absolute times."""

    def __init__(self, offset: float, on_event: EventFn):
        self.offset = offset
        self.on_event = on_event
        self.pending: list[_Piece] = []
        self.last_partial = ""
        self.last_end = 0.0  # relative end of the last final

    def _text(self, pieces: list[_Piece]) -> str:
        return re.sub(r"\s+", " ", "".join(p.text for p in pieces)).strip()

    async def add(self, piece: _Piece) -> None:
        starts_word = piece.text[:1].isspace()
        if self.pending and starts_word and piece.end - self.pending[0].start >= SEGMENT_MAX_SECONDS:
            await self.flush()
        self.pending.append(piece)
        text = self._text(self.pending)
        if text.endswith(SENTENCE_END) and len(text.split()) >= MIN_SENTENCE_WORDS:
            await self.flush()

    async def boundary(self, at: float) -> None:
        """A silence starts at `at`: close the open segment if it ends before it."""
        if self.pending and at >= self.pending[-1].end - 0.1:
            await self.flush()

    async def flush(self) -> None:
        if not self.pending:
            return
        text = self._text(self.pending)
        start = max(self.pending[0].start, self.last_end)
        end = max(self.pending[-1].end, start)
        self.pending = []
        self.last_end = end
        self.last_partial = ""
        if text:
            await self.on_event(TranscriptEvent(text, self.offset + start, self.offset + end, final=True))

    async def partial(self, buffer_text: str) -> None:
        text = (self._text(self.pending) + " " + (buffer_text or "")).strip()
        if text == self.last_partial:
            return
        self.last_partial = text
        start = max(self.pending[0].start, self.last_end) if self.pending else self.last_end
        end = max(self.pending[-1].end, start) if self.pending else start
        await self.on_event(TranscriptEvent(text, self.offset + start, self.offset + end, final=False))


# ---------------------------------------------------------------- model + device setup
def resolve_ct2_device(settings: Settings) -> tuple[str, str]:
    device = settings.whisper_device
    if device == "auto":
        device = "cuda" if cuda_usable() else "cpu"
    return device, settings.whisper_compute_type


def pin_ct2_device(device: str, compute_type: str) -> None:
    """WhisperLiveKit builds faster-whisper models with device="auto", which
    picks a GPU even when cuBLAS is missing and then crashes. Force ours."""
    import faster_whisper

    base = faster_whisper.WhisperModel
    if getattr(base, "_linaw_pinned", False):
        return

    class PinnedWhisperModel(base):
        _linaw_pinned = True

        def __init__(self, model_size_or_path, *args, **kwargs):
            kwargs.pop("device", None)
            kwargs.pop("compute_type", None)
            super().__init__(model_size_or_path, device=device, compute_type=compute_type, **kwargs)

    faster_whisper.WhisperModel = PinnedWhisperModel
    try:
        import whisperlivekit.simul_whisper.backend as simul_backend

        simul_backend.WhisperModel = PinnedWhisperModel
    except ImportError:
        pass


def _offline_hint(settings: Settings, what: str) -> str:
    return (
        f"WhisperLiveKit {what} for model '{settings.wlk_model}' was not found in "
        f"{settings.wlk_model_cache_dir}. Run `uv run scripts/download_models.py` while online, then restart."
    )


def resolve_wlk_models(settings: Settings) -> dict:
    """Local paths for the configured model. Never downloads."""
    try:
        from whisperlivekit.whisper import _MODELS
    except ImportError as e:
        raise ModelUnavailableError("whisperlivekit is not installed: uv sync (or pip install whisperlivekit)") from e
    from faster_whisper.utils import download_model

    out: dict = {}
    model = settings.wlk_model
    if settings.wlk_backend == "simulstreaming":
        if model not in _MODELS:
            raise ModelUnavailableError(
                f"WLK_MODEL={model!r} is not a Whisper model name SimulStreaming knows "
                f"({', '.join(k for k in _MODELS if not k.endswith('.en'))})"
            )
        pt = settings.wlk_model_cache_dir / Path(_MODELS[model]).name
        if not pt.is_file():
            raise ModelUnavailableError(_offline_hint(settings, f"decoder weights ({pt.name})"))
        out["decoder_pt"] = pt
    try:
        out["encoder_dir"] = download_model(
            model, cache_dir=str(settings.wlk_model_cache_dir), local_files_only=True
        )
    except Exception as e:
        raise ModelUnavailableError(_offline_hint(settings, "faster-whisper encoder")) from e
    return out


def warmup_file(settings: Settings) -> str:
    """A local warm-up clip (WhisperLiveKit's default downloads one)."""
    path = settings.wlk_model_cache_dir / "wlk_warmup.wav"
    if not path.is_file():
        import soundfile as sf

        path.parent.mkdir(parents=True, exist_ok=True)
        rng = np.random.default_rng(0)
        sf.write(str(path), (rng.standard_normal(SAMPLE_RATE * 2) * 0.01).astype("float32"), SAMPLE_RATE)
    return str(path)


def ffmpeg_status() -> str:
    found = shutil.which("ffmpeg")
    return f"not needed (raw PCM input){'; found at ' + found if found else ''}"


# ---------------------------------------------------------------- embedded engine
class _EmbeddedSession:
    def __init__(self, engine: "WhisperLiveKitEngine", offset, on_event, on_stats, on_warning):
        from whisperlivekit import AudioProcessor

        self.ap = AudioProcessor(transcription_engine=engine.tengine, pcm_input=True, mode="diff")
        self.seg = CommitSegmenter(offset, on_event)
        self.on_stats = on_stats
        self.on_warning = on_warning
        self.last_sig: tuple | None = None  # (start, end, text) of the last consumed token
        self.skipping = False
        self.skipped_seconds = 0.0
        self.received_seconds = 0.0
        self.reader: asyncio.Task | None = None
        self.ticker: asyncio.Task | None = None

    async def start(self) -> None:
        results = await self.ap.create_tasks()
        self.reader = asyncio.create_task(self._read(results))
        self.ticker = asyncio.create_task(self._stats_loop())

    async def _read(self, results) -> None:
        try:
            async for front in results:
                await self._handle(front)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("WhisperLiveKit result loop failed")
            await self.on_warning(f"WhisperLiveKit failed: {e}")

    async def _handle(self, front) -> None:
        if front.error:
            await self.on_warning(f"WhisperLiveKit: {front.error}")
        # Every update resends the retained history. Committed tokens are
        # append-only (pruned only at the front), but their timestamps are not
        # strictly increasing, so find new ones by position after the last
        # token we consumed rather than by time.
        events = []
        for line in front.lines:
            if line.is_silence():
                if line.start is not None:
                    events.append(("silence", line.start))
            else:
                events.extend(("token", t) for t in line.tokens or [] if t.start is not None)
        begin = 0
        if self.last_sig is not None:
            for i in range(len(events) - 1, -1, -1):
                kind, t = events[i]
                if kind == "token" and (t.start, t.end, t.text) == self.last_sig:
                    begin = i + 1
                    break
            else:  # last token pruned away (only after RETENTION_SECONDS): fall back to time
                begin = next((i for i, (k, t) in enumerate(events)
                              if k == "token" and t.start >= self.last_sig[1] - 1e-6), len(events))
        for kind, item in events[begin:]:
            if kind == "silence":
                await self.seg.boundary(item)
            else:
                self.last_sig = (item.start, item.end, item.text)
                await self.seg.add(_Piece(item.text, item.start, item.end))
        await self.seg.partial(front.buffer_transcription)

    def backlog_seconds(self) -> float:
        """Audio received but not yet processed by the ASR. Uses WhisperLiveKit's
        processed position (it also advances through silences), which includes
        audio inside a running inference call, not just the queue. During an
        ongoing silence that position waits for the silence to end, so fall back
        to the queued audio then; otherwise skipping (feeding zeros, i.e. more
        silence) could never stop."""
        ap = self.ap
        q = ap.transcription_queue
        queued = sum(x.size for x in getattr(q, "_queue", ()) if isinstance(x, np.ndarray)) if q else 0
        pending = len(ap.pcm_buffer) / BYTES_PER_SECOND
        backlog = queued / SAMPLE_RATE + pending
        if ap.current_silence is None:
            received = ap.total_pcm_samples / SAMPLE_RATE + pending
            backlog = max(backlog, received - max(0.0, ap.state.end_transcription_processed))
        return backlog

    async def push(self, chunk: bytes) -> None:
        seconds = len(chunk) / BYTES_PER_SECOND
        self.received_seconds += seconds
        backlog = self.backlog_seconds()
        if self.skipping and backlog < RESUME_BACKLOG_SECONDS:
            self.skipping = False
        elif not self.skipping and backlog > MAX_BACKLOG_SECONDS:
            self.skipping = True
            msg = f"Local engine is behind real time ({backlog:.1f}s backlog); skipping audio to catch up"
            log.warning(msg)
            await self.on_warning(msg)
        if self.skipping:
            self.skipped_seconds += seconds
            chunk = bytes(len(chunk))
        await self.ap.process_audio(chunk)

    async def _stats_loop(self) -> None:
        # RTF = inference seconds per second of audio received (sliding + session average).
        seen, compute, prev_compute, prev_audio = 0, 0.0, 0.0, 0.0
        while True:
            await asyncio.sleep(2.0)
            durations = self.ap.metrics.transcription_durations
            compute += sum(durations[seen:])
            seen = len(durations)
            audio = self.received_seconds
            d_audio = audio - prev_audio
            rtf = (compute - prev_compute) / d_audio if d_audio > 0 else None
            prev_compute, prev_audio = compute, audio
            await self.on_stats({
                "type": "stats",
                "engine": "local",
                "rtf": round(rtf, 3) if rtf is not None else None,
                "avg_rtf": round(compute / audio, 3) if audio > 0 else None,
                "lag_seconds": round(self.backlog_seconds(), 2),
                "dropped_seconds": round(self.skipped_seconds, 1),
            })

    async def finish(self, flush: bool) -> None:
        if self.ticker:
            self.ticker.cancel()
        if flush and self.reader:
            await self.ap.process_audio(b"")  # end of stream: WhisperLiveKit flushes, then the results end
            try:
                await asyncio.wait_for(asyncio.shield(self.reader), timeout=30)
            except asyncio.TimeoutError:
                log.warning("WhisperLiveKit did not finish within 30 s")
            await self.seg.flush()
        if self.reader and not self.reader.done():
            self.reader.cancel()
        await self.ap.cleanup()


class WhisperLiveKitEngine(LocalSTTEngine):
    name = "whisperlivekit"

    def __init__(self, settings: Settings):
        self.settings = settings
        self.device, self.compute_type = resolve_ct2_device(settings)
        pin_ct2_device(self.device, self.compute_type)
        paths = resolve_wlk_models(settings)
        from whisperlivekit import TranscriptionEngine

        kwargs = dict(
            model_size=settings.wlk_model,
            model_cache_dir=str(settings.wlk_model_cache_dir),
            backend_policy=settings.wlk_backend,
            backend="faster-whisper",
            lan=settings.wlk_language,
            diarization=settings.wlk_diarization,
            pcm_input=True,
            warmup_file=warmup_file(settings),
            log_level="WARNING",
        )
        if settings.wlk_backend == "simulstreaming":
            kwargs["encoder_model_path"] = paths["encoder_dir"]
        else:
            kwargs["model_dir"] = paths["encoder_dir"]
        t0 = time.perf_counter()
        self.tengine = TranscriptionEngine(**kwargs)  # loads models and runs the warm-up
        log.info("WhisperLiveKit %s/%s ready in %.1fs", settings.wlk_backend, settings.wlk_model, time.perf_counter() - t0)
        self.sessions: dict[str, _EmbeddedSession] = {}

    def info(self) -> dict:
        return {
            "engine": "whisperlivekit",
            "model": f"{self.settings.wlk_model} (faster-whisper encoder, {self.device}/{self.compute_type})",
            "backend": self.settings.wlk_backend,
            "integration": "embedded",
            "language": self.settings.wlk_language,
            "partials": True,
        }

    async def start_session(self, session_id, offset_seconds, on_event, on_stats, on_warning) -> None:
        sess = _EmbeddedSession(self, offset_seconds, on_event, on_stats, on_warning)
        await sess.start()
        self.sessions[session_id] = sess

    async def push_audio(self, session_id, chunk) -> None:
        sess = self.sessions.get(session_id)
        if sess:
            await sess.push(chunk)

    async def end_session(self, session_id, flush=True) -> None:
        sess = self.sessions.pop(session_id, None)
        if sess:
            await sess.finish(flush)


# ---------------------------------------------------------------- subprocess engine
def _parse_time(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    h, m, s = str(value).split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


class _ProxySession:
    """One /asr WebSocket to the WhisperLiveKit subprocess. Its messages carry
    line text without token timings, so new text per line becomes one piece."""

    def __init__(self, url: str, offset, on_event, on_stats, on_warning):
        self.url = url
        self.seg = CommitSegmenter(offset, on_event)
        self.on_stats = on_stats
        self.on_warning = on_warning
        self.line_chars: OrderedDict[str, int] = OrderedDict()
        self.consumed_until = 0.0
        self.ws = None
        self.reader: asyncio.Task | None = None

    async def start(self) -> None:
        import websockets

        self.ws = await websockets.connect(self.url, max_size=None)
        self.reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if msg.get("type") == "ready_to_stop":
                    break
                if msg.get("error"):
                    await self.on_warning(f"WhisperLiveKit: {msg['error']}")
                if "lines" in msg:
                    await self._handle(msg)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await self.on_warning(f"WhisperLiveKit server connection lost: {e}")

    async def _handle(self, msg: dict) -> None:
        for line in msg["lines"]:
            start, end = _parse_time(line["start"]), _parse_time(line["end"])
            if line.get("speaker") == -2:
                await self.seg.boundary(start)
                continue
            text = line.get("text") or ""
            key = str(line["start"])
            seen = self.line_chars.get(key, 0)
            if len(text) > seen and end > self.consumed_until:
                self.line_chars[key] = len(text)
                self.line_chars.move_to_end(key)
                while len(self.line_chars) > 200:
                    self.line_chars.popitem(last=False)
                piece_start = start if seen == 0 else max(start, self.consumed_until)
                self.consumed_until = end
                await self.seg.add(_Piece(text[seen:], piece_start, end))
        await self.seg.partial(msg.get("buffer_transcription", ""))
        await self.on_stats({
            "type": "stats", "engine": "local", "rtf": None, "avg_rtf": None,
            "lag_seconds": float(msg.get("remaining_time_transcription_processing") or 0),
            "dropped_seconds": 0.0,
        })

    async def push(self, chunk: bytes) -> None:
        await self.ws.send(chunk)

    async def finish(self, flush: bool) -> None:
        try:
            if flush:
                await self.ws.send(b"")  # end of stream
                await asyncio.wait_for(asyncio.shield(self.reader), timeout=30)
                await self.seg.flush()
        except Exception as e:
            log.warning("WhisperLiveKit proxy finish: %s", e)
        finally:
            if self.reader and not self.reader.done():
                self.reader.cancel()
            await self.ws.close()


class WhisperLiveKitSubprocessEngine(LocalSTTEngine):
    name = "whisperlivekit"

    def __init__(self, settings: Settings):
        import httpx

        self.settings = settings
        self.device, self.compute_type = resolve_ct2_device(settings)
        paths = resolve_wlk_models(settings)
        args = [
            sys.executable, "-m", "app.wlk_server",
            "--host", "127.0.0.1", "--port", str(settings.wlk_port),
            "--model", settings.wlk_model,
            "--model_cache_dir", str(settings.wlk_model_cache_dir),
            "--backend-policy", settings.wlk_backend,
            "--backend", "faster-whisper",
            "--language", settings.wlk_language,
            "--pcm-input",
            "--warmup-file", warmup_file(settings),
            "--retention-seconds", str(RETENTION_SECONDS),
            "--log-level", "WARNING",
        ]
        if settings.wlk_backend == "simulstreaming":
            args += ["--encoder-model-path", paths["encoder_dir"]]
        else:
            args += ["--model_dir", paths["encoder_dir"]]
        if settings.wlk_diarization:
            args.append("--diarization")
        env = dict(os.environ, HF_HUB_OFFLINE="1", LINAW_CT2_DEVICE=self.device,
                   LINAW_CT2_COMPUTE=self.compute_type)
        log.info("Starting WhisperLiveKit subprocess on port %s", settings.wlk_port)
        self.proc = subprocess.Popen(args, cwd=str(ROOT_DIR), env=env)
        health = f"http://127.0.0.1:{settings.wlk_port}/health"
        deadline = time.monotonic() + 600
        while True:
            if self.proc.poll() is not None:
                raise RuntimeError(f"WhisperLiveKit subprocess exited with code {self.proc.returncode}")
            try:
                if httpx.get(health, timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if time.monotonic() > deadline:
                self.proc.terminate()
                raise RuntimeError("WhisperLiveKit subprocess did not become ready within 10 minutes")
            time.sleep(0.5)
        self.url = f"ws://127.0.0.1:{settings.wlk_port}/asr?mode=full"
        self.sessions: dict[str, _ProxySession] = {}

    def info(self) -> dict:
        return {
            "engine": "whisperlivekit",
            "model": f"{self.settings.wlk_model} (faster-whisper encoder, {self.device}/{self.compute_type})",
            "backend": self.settings.wlk_backend,
            "integration": f"subprocess :{self.settings.wlk_port}",
            "language": self.settings.wlk_language,
            "partials": True,
        }

    async def start_session(self, session_id, offset_seconds, on_event, on_stats, on_warning) -> None:
        sess = _ProxySession(self.url, offset_seconds, on_event, on_stats, on_warning)
        await sess.start()
        self.sessions[session_id] = sess

    async def push_audio(self, session_id, chunk) -> None:
        sess = self.sessions.get(session_id)
        if sess:
            await sess.push(chunk)

    async def end_session(self, session_id, flush=True) -> None:
        sess = self.sessions.pop(session_id, None)
        if sess:
            await sess.finish(flush)

    async def aclose(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def create_wlk_engine(settings: Settings) -> LocalSTTEngine:
    if settings.wlk_embedded:
        return WhisperLiveKitEngine(settings)
    return WhisperLiveKitSubprocessEngine(settings)
