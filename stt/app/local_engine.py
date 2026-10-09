"""One streaming interface for every local (offline) STT engine.

    engine = create_local_engine(settings)          # once, at startup (loads + warms up)
    await engine.start_session(sid, offset_seconds, on_event, on_stats, on_warning)
    await engine.push_audio(sid, pcm_s16le_16k_mono)  # ~100 ms chunks
    await engine.end_session(sid)                    # flushes, emits the last finals

Engines emit TranscriptEvent objects. Times are absolute session seconds
(offset_seconds + position in this engine session), so they stay continuous
when the browser switches engines mid-session. The SessionHub assigns the
contract ids: a final gets the next id, a partial (final=False) carries the
id its final will get, so clients replace the live line in place.

Implementations:
  chunked         ChunkedEngine: the original 5 s windowed faster-whisper engine
  whisperlivekit  wlk_engine.WhisperLiveKitEngine: real-time partials (SimulStreaming
                  or LocalAgreement), embedded in-process or as a local subprocess
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from concurrent.futures import Executor
from dataclasses import dataclass

from .config import Settings
from .local_stream import FinalSegment, LocalStreamTranscriber
from .local_stt import BatchSTTEngine, create_engine

log = logging.getLogger("linaw.local_engine")


@dataclass
class TranscriptEvent:
    text: str
    start: float
    end: float
    final: bool
    engine: str = "local"


EventFn = Callable[[TranscriptEvent], Awaitable[None]]
StatsFn = Callable[[dict], Awaitable[None]]
WarnFn = Callable[[str], Awaitable[None]]


class LocalSTTEngine(ABC):
    name: str = ""

    @abstractmethod
    def info(self) -> dict:
        """Public description for /api/config and the startup summary."""

    @abstractmethod
    async def start_session(
        self, session_id: str, offset_seconds: float, on_event: EventFn, on_stats: StatsFn, on_warning: WarnFn
    ) -> None: ...

    @abstractmethod
    async def push_audio(self, session_id: str, chunk: bytes) -> None: ...

    @abstractmethod
    async def end_session(self, session_id: str, flush: bool = True) -> None:
        """flush=True transcribes the remaining audio before returning."""

    async def aclose(self) -> None:
        """Release engine-wide resources at shutdown."""


class ChunkedEngine(LocalSTTEngine):
    """The original engine: LOCAL_CHUNK_SECONDS windows, finals only."""

    name = "chunked"

    def __init__(self, settings: Settings, executor: Executor):
        self.settings = settings
        self.executor = executor
        self.batch: BatchSTTEngine = create_engine(settings)
        self.sessions: dict[str, LocalStreamTranscriber] = {}

    def info(self) -> dict:
        return {
            "engine": "chunked",
            "model": self.batch.model_label,
            "backend": f"{self.settings.local_chunk_seconds:g} s windows",
            "integration": "embedded",
            "partials": False,
        }

    async def start_session(self, session_id, offset_seconds, on_event, on_stats, on_warning) -> None:
        async def on_segments(segs: list[FinalSegment]) -> None:
            for s in segs:
                await on_event(TranscriptEvent(s.text, s.start, s.end, final=True))

        stream = LocalStreamTranscriber(
            self.batch, self.executor, self.settings.local_chunk_seconds,
            self.settings.local_chunk_overlap_seconds,
            on_segments=on_segments, on_stats=on_stats, on_warning=on_warning,
        )
        stream.start(offset_seconds)
        self.sessions[session_id] = stream

    async def push_audio(self, session_id, chunk) -> None:
        stream = self.sessions.get(session_id)
        if stream:
            stream.feed(chunk)

    async def end_session(self, session_id, flush=True) -> None:
        stream = self.sessions.pop(session_id, None)
        if stream is None:
            return
        if flush:
            await stream.flush()
        else:
            await stream.cancel()


def create_local_engine(settings: Settings, executor: Executor) -> LocalSTTEngine:
    """Blocking: loads and warms up the configured engine. Run it off the event loop."""
    if settings.local_engine_kind == "whisperlivekit":
        from .wlk_engine import create_wlk_engine

        return create_wlk_engine(settings)
    return ChunkedEngine(settings, executor)
