"""Local (offline) speech-to-text engines behind one interface.

Every engine takes raw PCM s16le mono 16 kHz audio and returns segments with
absolute timestamps (offset_seconds + position inside the chunk). Models are
loaded once, from local files only. Nothing is downloaded at runtime; run
scripts/download_models.py while online instead.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Protocol

import numpy as np

from .config import Settings

log = logging.getLogger("linaw.local_stt")

SAMPLE_RATE = 16000


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Segment:
    text: str
    start: float
    end: float
    words: list[Word] = field(default_factory=list)


class BatchSTTEngine(Protocol):
    """Transcribes one chunk at a time. Used by the "chunked" local engine
    (see local_engine.ChunkedEngine for the streaming wrapper)."""

    name: str
    model_label: str

    def transcribe(self, pcm16_bytes: bytes, offset_seconds: float) -> list[Segment]: ...


class ModelUnavailableError(RuntimeError):
    """The configured model is not on disk (and we refuse to download it)."""


def pcm16_to_float32(pcm16_bytes: bytes) -> np.ndarray:
    return np.frombuffer(pcm16_bytes, dtype="<i2").astype(np.float32) / 32768.0


def cuda_usable() -> bool:
    """True if CTranslate2 sees a GPU *and* the CUDA 12 cuBLAS library loads.
    device="auto" only checks the first, then crashes on the first inference."""
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() == 0:
            return False
    except Exception:
        return False
    import ctypes
    import sys

    lib = "cublas64_12.dll" if sys.platform == "win32" else "libcublas.so.12"
    try:
        ctypes.CDLL(lib)
        return True
    except OSError:
        return False


def mlx_repo_for(model: str) -> str:
    aliases = {"turbo": "large-v3-turbo", "large": "large-v3"}
    return f"mlx-community/whisper-{aliases.get(model, model)}" + (
        "" if model in ("turbo", "large-v3-turbo") else "-mlx"
    )


def mlx_local_dir(settings: Settings) -> Path:
    return settings.whisper_model_dir / f"mlx-whisper-{settings.whisper_model}"


def _offline_hint(settings: Settings) -> str:
    return (
        f"Local Whisper model '{settings.whisper_model}' was not found in {settings.whisper_model_dir}. "
        "Run `uv run scripts/download_models.py` while online, then restart."
    )


class FasterWhisperEngine:
    name = "faster-whisper"

    def __init__(self, settings: Settings):
        from faster_whisper import WhisperModel

        self.language = settings.whisper_language
        self.model_label = (
            f"faster-whisper {settings.whisper_model} ({settings.whisper_compute_type}, {settings.whisper_device})"
        )
        model_ref = settings.whisper_model
        if Path(model_ref).is_dir():  # explicit path to a converted model
            model_ref = str(Path(model_ref).resolve())
        try:
            self.model = WhisperModel(
                model_ref,
                device=settings.whisper_device,
                compute_type=settings.whisper_compute_type,
                download_root=str(settings.whisper_model_dir),
                local_files_only=True,
            )
        except Exception as e:  # huggingface_hub raises various "not found locally" errors
            msg = str(e).lower()
            if "local" in msg or "not found" in msg or "snapshot" in msg or "no such file" in msg:
                raise ModelUnavailableError(_offline_hint(settings)) from e
            raise
        # CTranslate2 models are not documented as thread-safe for concurrent
        # generate calls from one Python object; serialise to be safe.
        self._lock = threading.Lock()

    def _run(self, audio: np.ndarray, offset_seconds: float, vad: bool) -> list[Segment]:
        with self._lock:
            segments, _info = self.model.transcribe(
                audio,
                language=self.language,
                beam_size=1,
                vad_filter=vad,
                vad_parameters={"min_silence_duration_ms": 500},
                word_timestamps=True,
                condition_on_previous_text=False,
                # No temperature fallback: on low-confidence audio (e.g. Taglish) it
                # re-decodes up to 5 more times and runs slower than real time.
                temperature=0.0,
            )
            out = []
            for seg in segments:  # generator: inference happens while iterating
                words = [
                    Word(w.word, offset_seconds + w.start, offset_seconds + w.end)
                    for w in (seg.words or [])
                ]
                out.append(
                    Segment(seg.text.strip(), offset_seconds + seg.start, offset_seconds + seg.end, words)
                )
            return out

    def transcribe(self, pcm16_bytes: bytes, offset_seconds: float) -> list[Segment]:
        return self._run(pcm16_to_float32(pcm16_bytes), offset_seconds, vad=True)

    def warmup(self) -> None:
        # VAD would drop pure silence before the decoder runs, so warm up without it.
        self._run(np.zeros(SAMPLE_RATE, dtype=np.float32), 0.0, vad=False)


class MlxWhisperEngine:
    """Apple Silicon engine. mlx-whisper has no built-in VAD, so quiet chunks
    are skipped with a simple energy gate instead."""

    name = "mlx-whisper"
    SILENCE_RMS = 0.004

    def __init__(self, settings: Settings):
        try:
            import mlx_whisper  # noqa: F401
        except ImportError as e:
            raise ModelUnavailableError(
                "LOCAL_STT_ENGINE=mlx-whisper but the mlx-whisper package is not installed "
                "(Apple Silicon only): pip install mlx-whisper"
            ) from e
        self._mlx = mlx_whisper
        path = Path(settings.whisper_model)
        if not path.is_dir():
            path = mlx_local_dir(settings)
        if not (path / "weights.npz").exists() and not (path / "weights.safetensors").exists():
            raise ModelUnavailableError(_offline_hint(settings))
        self.path = str(path)
        self.language = settings.whisper_language
        self.model_label = f"mlx-whisper {settings.whisper_model}"
        self._lock = threading.Lock()

    def transcribe(self, pcm16_bytes: bytes, offset_seconds: float) -> list[Segment]:
        audio = pcm16_to_float32(pcm16_bytes)
        if audio.size == 0 or float(np.sqrt(np.mean(audio**2))) < self.SILENCE_RMS:
            return []
        return self._run(audio, offset_seconds)

    def _run(self, audio: np.ndarray, offset_seconds: float) -> list[Segment]:
        with self._lock:
            result = self._mlx.transcribe(
                audio,
                path_or_hf_repo=self.path,
                language=self.language,
                word_timestamps=True,
                condition_on_previous_text=False,
                temperature=0.0,
                verbose=None,
            )
        out = []
        for seg in result.get("segments", []):
            words = [
                Word(w["word"], offset_seconds + w["start"], offset_seconds + w["end"])
                for w in seg.get("words", [])
            ]
            out.append(
                Segment(seg["text"].strip(), offset_seconds + seg["start"], offset_seconds + seg["end"], words)
            )
        return out

    def warmup(self) -> None:
        self._run(np.zeros(SAMPLE_RATE, dtype=np.float32), 0.0)


def create_engine(settings: Settings) -> BatchSTTEngine:
    """Load the configured engine once and warm it up on 1 s of silence."""
    t0 = time.perf_counter()
    if settings.local_stt_engine == "mlx-whisper":
        engine = MlxWhisperEngine(settings)
    else:
        engine = FasterWhisperEngine(settings)
    t1 = time.perf_counter()
    try:
        engine.warmup()
    except RuntimeError as e:
        # device=auto picks CUDA when a GPU exists, even if cuBLAS/cuDNN are missing.
        gpu_libs = any(k in str(e).lower() for k in ("cuda", "cublas", "cudnn"))
        if engine.name != "faster-whisper" or settings.whisper_device != "auto" or not gpu_libs:
            raise
        log.warning("CUDA unavailable (%s); falling back to CPU", e)
        settings = replace(settings, whisper_device="cpu")
        engine = FasterWhisperEngine(settings)
        t1 = time.perf_counter()
        engine.warmup()
    log.info(
        "Loaded %s in %.1fs, warm-up %.1fs", engine.model_label, t1 - t0, time.perf_counter() - t1
    )
    return engine
