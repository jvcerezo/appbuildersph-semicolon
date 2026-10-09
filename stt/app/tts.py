"""Soniox text-to-speech: one REST call per read-aloud request, no streaming —
the text is always short (a jargon card). No local TTS model exists in this
repo and building one is out of scope; any failure here is caught by main.py
and answered 503, so the UI falls back to its own on-device voice.
"""

from __future__ import annotations

import logging

import httpx

from .config import Settings

log = logging.getLogger("linaw.tts")


class TtsUnavailable(Exception):
    pass


async def synthesize(settings: Settings, text: str, language: str) -> tuple[bytes, str]:
    """POST https://tts-rt.soniox.com/tts: JSON in, raw audio bytes out. A
    Soniox voice works in any language; `language` just picks pronunciation."""
    body = {
        "model": settings.soniox_tts_model,
        "voice": settings.soniox_tts_voice,
        "language": language,
        "text": text,
        "audio_format": settings.soniox_tts_audio_format,
    }
    try:
        async with httpx.AsyncClient(timeout=settings.soniox_tts_timeout_seconds) as client:
            r = await client.post(
                settings.soniox_tts_url,
                headers={"Authorization": f"Bearer {settings.soniox_api_key}"},
                json=body,
            )
    except httpx.HTTPError as e:
        log.warning("Soniox TTS request failed: %s", type(e).__name__)
        raise TtsUnavailable("could not reach Soniox TTS") from e
    if not 200 <= r.status_code < 300:
        log.warning("Soniox TTS error: HTTP %s", r.status_code)
        raise TtsUnavailable(f"Soniox TTS returned HTTP {r.status_code}")
    mime_type = r.headers.get("content-type", "audio/mpeg").split(";")[0].strip()
    return r.content, mime_type
