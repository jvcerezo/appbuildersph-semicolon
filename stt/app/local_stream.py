"""Real-time windowing on top of a BatchSTTEngine (the "chunked" local engine).

Audio arrives in ~100 ms PCM chunks. We transcribe fixed windows of
LOCAL_CHUNK_SECONDS that overlap by LOCAL_CHUNK_OVERLAP_SECONDS:

    window k:   [t, t+W)            commit words whose midpoint < t+W-O
    window k+1: [t+W-O, t+2W-O)     drop words whose midpoint < committed_until

Words straddling the cut are decided once by their midpoint, and a short
n-gram check removes any repeat Whisper still produces at the boundary.

Inference runs in a single worker thread. While it runs, new audio
accumulates; if the backlog exceeds MAX_BACKLOG_WINDOWS windows we drop the
oldest audio (logged), so memory and lag stay bounded on slow machines.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import Executor
from dataclasses import dataclass

from .local_stt import SAMPLE_RATE, BatchSTTEngine, Segment, Word

log = logging.getLogger("linaw.local_stream")

BYTES_PER_SECOND = SAMPLE_RATE * 2
MAX_BACKLOG_WINDOWS = 2.0
MIN_FLUSH_SECONDS = 0.3
MAX_SEGMENT_SECONDS = 10.0
PAUSE_SECONDS = 0.8


@dataclass
class FinalSegment:
    text: str
    start: float
    end: float


def _norm(word: str) -> str:
    return re.sub(r"[^\w]", "", word.lower())


def _strip_repeated_prefix(prev_tail: list[str], words: list[Word]) -> list[Word]:
    """Drop words at the start of `words` that repeat the end of the last commit."""
    new = [_norm(w.text) for w in words]
    for n in range(min(len(prev_tail), len(new), 5), 0, -1):
        if prev_tail[-n:] == new[:n] and any(prev_tail[-n:]):
            return words[n:]
    return words


def _close_groups(words: list[Word], cut: float, final: bool) -> tuple[list[FinalSegment], list[Word]]:
    """Split committed words into segments on pauses and length. The last
    group stays pending (it may continue in the next window) unless it ends a
    sentence, is followed by silence up to the cut, or this is the final flush."""
    groups: list[list[Word]] = []
    for w in words:
        if groups and (
            w.start - groups[-1][-1].end > PAUSE_SECONDS or w.end - groups[-1][0].start > MAX_SEGMENT_SECONDS
        ):
            groups.append([])
        if not groups:
            groups.append([])
        groups[-1].append(w)
    pending: list[Word] = []
    if groups and not final:
        last = groups[-1]
        ends_sentence = last[-1].text.strip().endswith((".", "?", "!"))
        if not ends_sentence and cut - last[-1].end <= PAUSE_SECONDS:
            pending = groups.pop()
    return [s for s in (_join(g) for g in groups) if s.text], pending


def _join(words: list[Word]) -> FinalSegment:
    text = "".join(w.text for w in words).strip()
    return FinalSegment(re.sub(r"\s+", " ", text), round(words[0].start, 2), round(words[-1].end, 2))


def _segment_words(seg: Segment) -> list[Word]:
    # Engines without word timings: treat the whole segment as one "word".
    return seg.words or [Word(" " + seg.text, seg.start, seg.end)]


class LocalStreamTranscriber:
    def __init__(
        self,
        engine: BatchSTTEngine,
        executor: Executor,
        chunk_seconds: float,
        overlap_seconds: float,
        on_segments: Callable[[list[FinalSegment]], Awaitable[None]],
        on_stats: Callable[[dict], Awaitable[None]],
        on_warning: Callable[[str], Awaitable[None]],
    ):
        self.engine = engine
        self.executor = executor
        self.window = chunk_seconds
        self.overlap = overlap_seconds
        self.on_segments = on_segments
        self.on_stats = on_stats
        self.on_warning = on_warning

        self.buf = bytearray()
        self.buf_start = 0.0  # absolute time (s) of buf[0]
        self.committed_until = 0.0
        self.prev_tail: list[str] = []
        self.pending: list[Word] = []  # committed words not yet emitted (segment still open)
        self.last_end = 0.0
        self.task: asyncio.Task | None = None
        self.dropped_seconds = 0.0
        self.audio_processed = 0.0
        self.compute_seconds = 0.0
        self.last_rtf = 0.0
        self.flushing = False

    def start(self, offset_seconds: float) -> None:
        self.buf.clear()
        self.pending = []
        self.buf_start = self.committed_until = self.last_end = max(0.0, offset_seconds)

    @property
    def buffered_seconds(self) -> float:
        return len(self.buf) / BYTES_PER_SECOND

    def feed(self, pcm: bytes) -> None:
        if len(pcm) % 2:
            pcm = pcm[:-1]
        self.buf.extend(pcm)
        limit = self.window * (1 + MAX_BACKLOG_WINDOWS)
        if self.buffered_seconds > limit:
            keep = int(self.window * BYTES_PER_SECOND) & ~1
            drop = len(self.buf) - keep
            dropped = drop / BYTES_PER_SECOND
            del self.buf[:drop]
            self.buf_start += dropped
            self.committed_until = max(self.committed_until, self.buf_start)
            self.prev_tail = []
            self.dropped_seconds += dropped
            msg = f"Local engine is behind real time; skipped {dropped:.1f}s of audio"
            log.warning(msg)
            asyncio.get_running_loop().create_task(self.on_warning(msg))
        self._maybe_schedule()

    def _maybe_schedule(self) -> None:
        if not self.flushing and self.task is None and self.buffered_seconds >= self.window:
            self.task = asyncio.get_running_loop().create_task(self._process(final=False))

    async def _process(self, final: bool) -> None:
        n = len(self.buf) if final else int(self.window * BYTES_PER_SECOND) & ~1
        chunk = bytes(self.buf[:n])
        start = self.buf_start
        duration = len(chunk) / BYTES_PER_SECOND
        cut = start + duration if final else start + duration - self.overlap
        try:
            t0 = time.perf_counter()
            segments = await asyncio.get_running_loop().run_in_executor(
                self.executor, self.engine.transcribe, chunk, start
            )
            elapsed = time.perf_counter() - t0
            self.audio_processed += duration
            self.compute_seconds += elapsed
            self.last_rtf = elapsed / duration if duration else 0.0

            words = [
                w
                for seg in segments
                for w in _segment_words(seg)
                if self.committed_until <= (w.start + w.end) / 2 < cut
            ]
            words = _strip_repeated_prefix(self.prev_tail, words)
            if words:
                self.prev_tail = [_norm(w.text) for w in words[-5:]]

            # Advance the buffer. A drop in feed() may have moved buf_start while we ran.
            if final:
                self.buf.clear()
                self.buf_start = cut
            else:
                advance = max(0.0, cut - self.buf_start)
                del self.buf[: int(advance * BYTES_PER_SECOND) & ~1]
                self.buf_start = max(self.buf_start, cut)
            self.committed_until = max(self.committed_until, cut)

            out, self.pending = _close_groups(self.pending + words, cut, final)
            await self._emit(out)
            await self.on_stats(
                {
                    "type": "stats",
                    "engine": "local",
                    "rtf": round(self.last_rtf, 3),
                    "avg_rtf": round(self.compute_seconds / self.audio_processed, 3)
                    if self.audio_processed
                    else 0.0,
                    "lag_seconds": round(self.buffered_seconds, 2),
                    "dropped_seconds": round(self.dropped_seconds, 1),
                }
            )
        except Exception as e:
            log.exception("Local transcription failed")
            # Skip this window so a bad chunk cannot stall the stream.
            skip = max(0.0, cut - self.buf_start)
            del self.buf[: int(skip * BYTES_PER_SECOND) & ~1]
            self.buf_start = max(self.buf_start, cut)
            self.committed_until = max(self.committed_until, cut)
            await self.on_warning(f"Local transcription failed: {e}")
        finally:
            self.task = None
        if not final:
            self._maybe_schedule()

    async def _emit(self, out: list[FinalSegment]) -> None:
        for seg in out:  # keep timestamps monotonic across window boundaries
            seg.start = max(seg.start, self.last_end)
            seg.end = max(seg.end, seg.start)
            self.last_end = seg.end
        if out:
            await self.on_segments(out)

    async def flush(self) -> None:
        """Transcribe whatever is left (called when the session stops)."""
        self.flushing = True
        while self.task:
            await self.task
        while self.buffered_seconds >= self.window:
            await self._process(final=False)
        if self.buffered_seconds >= MIN_FLUSH_SECONDS:
            await self._process(final=True)
        if self.pending:
            out, self.pending = _close_groups(self.pending, self.committed_until, final=True)
            await self._emit(out)
        self.buf.clear()

    async def cancel(self) -> None:
        self.flushing = True
        self.buf.clear()
        if self.task:
            try:
                await self.task
            except Exception:
                pass
