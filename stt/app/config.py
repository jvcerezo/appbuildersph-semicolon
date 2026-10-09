"""Environment configuration for the Linaw speech pipeline.

All values come from .env (via python-dotenv) so demo settings can change
without touching code. The long-lived SONIOX_API_KEY is held here and only
used server-side when minting temporary keys; it is never serialised.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

log = logging.getLogger("linaw.config")

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

VALID_MODES = ("auto", "soniox", "local", "local_only")
# "chunked" is the original windowed engine (faster-whisper). "faster-whisper"
# is kept as an alias for it, and "mlx-whisper" is the chunked engine on MLX.
VALID_LOCAL_ENGINES = ("whisperlivekit", "chunked", "faster-whisper", "mlx-whisper")
VALID_WLK_BACKENDS = ("simulstreaming", "localagreement")


def _str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _int(name: str, default: int) -> int:
    raw = _str(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise SystemExit(f"[config] {name} must be an integer, got {raw!r}")


def _float(name: str, default: float) -> float:
    raw = _str(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        raise SystemExit(f"[config] {name} must be a number, got {raw!r}")


def _bool(name: str, default: bool) -> bool:
    raw = _str(name).lower()
    if not raw:
        return default
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    raise SystemExit(f"[config] {name} must be true or false, got {raw!r}")


def _resolve(path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else (ROOT_DIR / p).resolve()


@dataclass(frozen=True)
class Settings:
    host: str
    port: int

    soniox_api_key: str = field(repr=False)
    soniox_temp_key_url: str
    soniox_ws_url: str
    soniox_model: str
    soniox_language_hints: list[str]
    soniox_temp_key_ttl_seconds: int
    soniox_max_session_seconds: int

    stt_mode: str
    connectivity_check_url: str
    connectivity_timeout_seconds: float

    soniox_tts_url: str
    soniox_tts_model: str
    soniox_tts_voice: str
    soniox_tts_audio_format: str
    soniox_tts_timeout_seconds: float

    local_stt_engine: str
    whisper_model: str
    whisper_model_dir: Path
    whisper_device: str
    whisper_compute_type: str
    whisper_language: str | None
    local_chunk_seconds: float
    local_chunk_overlap_seconds: float

    wlk_model: str
    wlk_backend: str
    wlk_language: str
    wlk_diarization: bool
    wlk_model_cache_dir: Path
    wlk_embedded: bool
    wlk_port: int

    cloud_cost_per_hour_estimate: float

    stt_terms_path: Path

    @property
    def soniox_configured(self) -> bool:
        return bool(self.soniox_api_key)

    @property
    def cloud_allowed(self) -> bool:
        """False in local_only mode: the backend never contacts the cloud."""
        return self.stt_mode != "local_only"

    @property
    def local_engine_kind(self) -> str:
        return "whisperlivekit" if self.local_stt_engine == "whisperlivekit" else "chunked"


def load_settings() -> Settings:
    s = Settings(
        host=_str("HOST", "127.0.0.1"),
        port=_int("PORT", 8000),
        soniox_api_key=_str("SONIOX_API_KEY"),
        soniox_temp_key_url=_str(
            "SONIOX_TEMP_KEY_URL", "https://api.soniox.com/v1/auth/temporary-api-key"
        ),
        soniox_ws_url=_str("SONIOX_WS_URL", "wss://stt-rt.soniox.com/transcribe-websocket"),
        soniox_model=_str("SONIOX_MODEL", "stt-rt-v5"),
        soniox_language_hints=[
            x.strip() for x in _str("SONIOX_LANGUAGE_HINTS", "en,tl").split(",") if x.strip()
        ],
        soniox_temp_key_ttl_seconds=_int("SONIOX_TEMP_KEY_TTL_SECONDS", 60),
        soniox_max_session_seconds=_int("SONIOX_MAX_SESSION_SECONDS", 14400),
        stt_mode=_str("STT_MODE", "auto").lower(),
        connectivity_check_url=_str("CONNECTIVITY_CHECK_URL", "https://api.soniox.com"),
        connectivity_timeout_seconds=_float("CONNECTIVITY_TIMEOUT_SECONDS", 2.0),
        soniox_tts_url=_str("SONIOX_TTS_URL", "https://tts-rt.soniox.com/tts"),
        soniox_tts_model=_str("SONIOX_TTS_MODEL", "tts-rt-v2"),
        soniox_tts_voice=_str("SONIOX_TTS_VOICE", "Adrian"),
        soniox_tts_audio_format=_str("SONIOX_TTS_AUDIO_FORMAT", "mp3"),
        soniox_tts_timeout_seconds=_float("SONIOX_TTS_TIMEOUT_SECONDS", 10.0),
        local_stt_engine=_str("LOCAL_STT_ENGINE", "whisperlivekit").lower(),
        whisper_model=_str("WHISPER_MODEL", "small"),
        whisper_model_dir=_resolve(_str("WHISPER_MODEL_DIR") or "./models"),
        whisper_device=_str("WHISPER_DEVICE", "auto"),
        whisper_compute_type=_str("WHISPER_COMPUTE_TYPE", "int8"),
        whisper_language=_str("WHISPER_LANGUAGE") or None,
        local_chunk_seconds=_float("LOCAL_CHUNK_SECONDS", 5.0),
        local_chunk_overlap_seconds=_float("LOCAL_CHUNK_OVERLAP_SECONDS", 0.5),
        wlk_model=_str("WLK_MODEL", "small"),
        wlk_backend=_str("WLK_BACKEND", "simulstreaming").lower(),
        wlk_language=_str("WLK_LANGUAGE") or "auto",
        wlk_diarization=_bool("WLK_DIARIZATION", False),
        wlk_model_cache_dir=_resolve(_str("WLK_MODEL_CACHE_DIR") or "./models"),
        wlk_embedded=_bool("WLK_EMBEDDED", True),
        wlk_port=_int("WLK_PORT", 8001),
        cloud_cost_per_hour_estimate=_float("CLOUD_COST_PER_HOUR_ESTIMATE", 0.0),
        stt_terms_path=ROOT_DIR / "content" / "stt_terms.json",
    )
    _validate(s)
    return s


def _validate(s: Settings) -> None:
    errors = []
    if s.stt_mode not in VALID_MODES:
        errors.append(f"STT_MODE must be one of {VALID_MODES}, got {s.stt_mode!r}")
    if s.local_stt_engine not in VALID_LOCAL_ENGINES:
        errors.append(
            f"LOCAL_STT_ENGINE must be one of {VALID_LOCAL_ENGINES}, got {s.local_stt_engine!r}"
        )
    if s.local_chunk_seconds < 1:
        errors.append("LOCAL_CHUNK_SECONDS must be >= 1")
    if not 0 <= s.local_chunk_overlap_seconds < s.local_chunk_seconds / 2:
        errors.append("LOCAL_CHUNK_OVERLAP_SECONDS must be >= 0 and < half of LOCAL_CHUNK_SECONDS")
    if s.wlk_backend not in VALID_WLK_BACKENDS:
        errors.append(f"WLK_BACKEND must be one of {VALID_WLK_BACKENDS}, got {s.wlk_backend!r}")
    if s.wlk_model.endswith(".en"):
        errors.append(
            f"WLK_MODEL={s.wlk_model!r} is English-only; use a multilingual model (e.g. small) "
            "for Tagalog and for the SimulStreaming backend"
        )
    if s.wlk_port == s.port:
        errors.append("WLK_PORT must differ from PORT")
    if s.cloud_cost_per_hour_estimate < 0:
        errors.append("CLOUD_COST_PER_HOUR_ESTIMATE must be >= 0")
    if not 10 <= s.soniox_temp_key_ttl_seconds <= 3600:
        errors.append("SONIOX_TEMP_KEY_TTL_SECONDS should be between 10 and 3600")
    if s.soniox_tts_timeout_seconds <= 0:
        errors.append("SONIOX_TTS_TIMEOUT_SECONDS must be > 0")
    if errors:
        raise SystemExit("[config] Invalid configuration:\n  - " + "\n  - ".join(errors))


def load_stt_terms(s: Settings) -> list[str]:
    """Context terms for Soniox. Accepts a JSON list or {"terms": [...]}."""
    if not s.stt_terms_path.is_file():
        return []
    try:
        data = json.loads(s.stt_terms_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("Could not read %s: %s", s.stt_terms_path, e)
        return []
    if isinstance(data, dict):
        data = data.get("terms", [])
    if not isinstance(data, list):
        log.warning("%s must be a list of strings", s.stt_terms_path)
        return []
    return [str(t).strip() for t in data if str(t).strip()]
