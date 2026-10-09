"""Linaw speech pipeline: FastAPI backend.

Routes
  GET  /                         temporary HTML test harness
  GET  /api/config               public STT config (never contains the long-lived key)
  GET  /api/connectivity         can the backend reach the internet?
  POST /api/soniox/temp-key      mint a short-lived, single-use Soniox key
  GET  /api/session/transcript   final segments of the current session
  GET  /api/session/metrics      latest "metrics" message (cloud meter)
  WS   /ws/session               unified transcript/status/metrics bus (browser posts, everyone receives)
  WS   /ws/stt-local             PCM in, local engine segments out (via /ws/session)
  WS   /ws/stream                for backends: PCM in, Soniox or local transcripts out, with fallback
  POST /api/transcribe           one short clip (a spoken question), local engine only
  POST /api/tts                  read aloud via Soniox TTS; 503 when cloud isn't available
"""

from __future__ import annotations

import os

# Local models are loaded from disk only; never let Hugging Face reach the network at runtime.
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import asyncio  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import time  # noqa: E402
import uuid  # noqa: E402
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import httpx  # noqa: E402
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.responses import FileResponse, Response  # noqa: E402

from .config import ROOT_DIR, load_settings, load_stt_terms  # noqa: E402
from .local_engine import LocalSTTEngine, TranscriptEvent, create_local_engine  # noqa: E402
from .local_stt import ModelUnavailableError, create_engine  # noqa: E402
from .session import SessionHub  # noqa: E402
from .stream import StreamSession  # noqa: E402
from .tts import TtsUnavailable  # noqa: E402
from .tts import synthesize as tts_synthesize  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("linaw")
# WhisperLiveKit logs every decode step at INFO; keep the console readable.
for _name in ("whisperlivekit", "faster_whisper"):
    logging.getLogger(_name).setLevel(logging.WARNING)

settings = load_settings()
hub = SessionHub()
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")
state: dict = {"engine": None, "engine_error": None}

SONIOX_DOMAIN_CONTEXT = "Philippine impeachment trial / Senate hearing"


def _print_summary() -> None:
    engine: LocalSTTEngine | None = state["engine"]
    if not settings.cloud_allowed:
        soniox = "OFF (STT_MODE=local_only: no cloud calls at all)"
    elif settings.soniox_configured:
        soniox = f"available, model {settings.soniox_model}"
    else:
        soniox = "DISABLED (SONIOX_API_KEY not set)"
    if engine:
        i = engine.info()
        local = f"available, {i['engine']}: {i['model']}, {i['backend']}, {i['integration']}"
    else:
        local = f"UNAVAILABLE ({settings.local_engine_kind}) - {state['engine_error']}"
    lines = [
        "",
        "Linaw STT pipeline",
        f"  Mode (STT_MODE):  {settings.stt_mode}",
        f"  Soniox (online):  {soniox}",
        f"  Local (offline):  {local}",
    ]
    if settings.local_engine_kind == "whisperlivekit":
        from .wlk_engine import ffmpeg_status

        lines.append(f"  FFmpeg:           {ffmpeg_status()}")
    else:
        lines.append(f"  Window:           {settings.local_chunk_seconds}s, overlap {settings.local_chunk_overlap_seconds}s")
    lines += [
        f"  Context terms:    {len(load_stt_terms(settings))} from {settings.stt_terms_path.name}",
        f"  Cloud meter:      {settings.cloud_cost_per_hour_estimate:g} per hour (CLOUD_COST_PER_HOUR_ESTIMATE)",
        f"  Open:             http://{settings.host}:{settings.port}/",
        "",
    ]
    print("\n".join(lines), flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        state["engine"] = await asyncio.get_running_loop().run_in_executor(
            executor, create_local_engine, settings, executor
        )
    except ModelUnavailableError as e:
        state["engine_error"] = str(e)
        log.error(str(e))
    except Exception as e:
        state["engine_error"] = f"{type(e).__name__}: {e}"
        log.exception("Could not load local STT engine")
    # WhisperLiveKit sets its own log levels while loading; quiet it again afterwards.
    for name in list(logging.root.manager.loggerDict):
        if name.startswith(("whisperlivekit", "faster_whisper")):
            logging.getLogger(name).setLevel(logging.WARNING)
    _print_summary()
    clip_warmup = asyncio.create_task(_clip_engine())
    clip_warmup.add_done_callback(lambda t: t.exception() and log.warning("Spoken questions unavailable: %s", t.exception()))
    yield
    if state["engine"]:
        await state["engine"].aclose()
    executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Linaw STT", lifespan=lifespan)


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(ROOT_DIR / "static" / "index.html")


@app.get("/api/config")
async def get_config():
    engine: LocalSTTEngine | None = state["engine"]
    info = engine.info() if engine else {}
    return {
        "stt_mode": settings.stt_mode,
        "cloud_allowed": settings.cloud_allowed,
        "sample_rate": 16000,
        "cloud_cost_per_hour_estimate": settings.cloud_cost_per_hour_estimate,
        "soniox": {
            "available": settings.soniox_configured and settings.cloud_allowed,
            "ws_url": settings.soniox_ws_url,
            "start_config": {
                "model": settings.soniox_model,
                "audio_format": "pcm_s16le",
                "sample_rate": 16000,
                "num_channels": 1,
                "language_hints": settings.soniox_language_hints,
                "enable_endpoint_detection": True,
                "context": {
                    "general": [{"key": "domain", "value": SONIOX_DOMAIN_CONTEXT}],
                    "terms": load_stt_terms(settings),
                },
            },
        },
        "local": {
            "available": engine is not None,
            "engine": info.get("engine", settings.local_engine_kind),
            "model": info.get("model", settings.wlk_model if settings.local_engine_kind == "whisperlivekit"
                              else settings.whisper_model),
            "backend": info.get("backend"),
            "integration": info.get("integration"),
            "partials": info.get("partials", False),
            "error": state["engine_error"],
            "chunk_seconds": settings.local_chunk_seconds,
            "overlap_seconds": settings.local_chunk_overlap_seconds,
        },
    }


@app.get("/api/connectivity")
async def connectivity():
    if not settings.cloud_allowed:
        return {"online": False, "skipped": True, "latency_ms": 0, "soniox_configured": False}
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=settings.connectivity_timeout_seconds) as client:
            await client.head(settings.connectivity_check_url, follow_redirects=False)
        online = True
    except httpx.HTTPError:
        online = False
    return {
        "online": online,
        "latency_ms": round((time.perf_counter() - t0) * 1000),
        "soniox_configured": settings.soniox_configured,
    }


@app.post("/api/soniox/temp-key")
async def soniox_temp_key():
    if not settings.cloud_allowed:
        raise HTTPException(403, "STT_MODE=local_only: cloud transcription is disabled")
    if not settings.soniox_configured:
        raise HTTPException(503, "SONIOX_API_KEY is not set on the server")
    body = {
        "usage_type": "transcribe_websocket",
        "expires_in_seconds": settings.soniox_temp_key_ttl_seconds,
        "single_use": True,
        "max_session_duration_seconds": settings.soniox_max_session_seconds,
        "client_reference_id": "linaw-dev",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                settings.soniox_temp_key_url,
                headers={"Authorization": f"Bearer {settings.soniox_api_key}"},
                json=body,
            )
    except httpx.HTTPError as e:
        # Exception text carries the URL only, never request headers.
        log.warning("Soniox temp-key request failed: %s", type(e).__name__)
        raise HTTPException(502, "Could not reach Soniox to create a temporary key")
    if not 200 <= r.status_code < 300:  # Soniox answers 201 Created on success
        detail = {401: "Soniox rejected the API key", 403: "API key lacks the Temporary API keys permission",
                  429: "Soniox rate limit reached"}.get(r.status_code, f"Soniox returned HTTP {r.status_code}")
        log.warning("Soniox temp-key error: HTTP %s", r.status_code)
        raise HTTPException(502, detail)
    data = r.json()
    if not data.get("api_key"):
        raise HTTPException(502, "Soniox response did not contain a temporary key")
    return {"api_key": data["api_key"], "expires_at": data.get("expires_at")}


@app.get("/api/session/transcript")
async def session_transcript():
    return hub.transcript()


@app.get("/api/session/metrics")
async def session_metrics():
    return hub.metrics or {
        "type": "metrics", "engine": None, "cloud_bytes_sent": 0, "session_seconds": 0,
        "avg_first_word_latency_ms": None, "cloud_cost_estimate": 0.0,
    }


@app.websocket("/ws/session")
async def ws_session(ws: WebSocket):
    """Unified bus. Browsers post Soniox segments and status events here;
    every connected client (test page, real frontend, LLM service) receives
    the broadcast in the contract format."""
    await hub.connect(ws)
    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except (json.JSONDecodeError, TypeError):
                continue
            kind = msg.get("type")
            if kind == "session_start":
                hub.reset()
            elif kind == "transcript":
                try:
                    args = (str(msg.get("text", "")), float(msg["start"]), float(msg["end"]), str(msg.get("engine")))
                except (KeyError, TypeError, ValueError):
                    continue
                if msg.get("final"):
                    await hub.add_final(*args)
                else:
                    await hub.add_partial(*args)
            elif kind == "status":
                await hub.status(str(msg.get("state")), str(msg.get("engine", "")), str(msg.get("message", "")))
            elif kind == "metrics_report":
                await hub.report_metrics(msg, settings.cloud_cost_per_hour_estimate)
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws)


@app.websocket("/ws/stt-local")
async def ws_stt_local(ws: WebSocket):
    """Protocol: text {"type":"start","offset_seconds":X}, then binary PCM
    s16le mono 16 kHz frames, then text {"type":"stop"}. The server replies
    with {"type":"stats",...} and finally {"type":"done"}. {"type":"abort"}
    ends the session like "stop" but discards unfinalised audio. Transcript
    segments go out on /ws/session.

    A client may connect and wait (standby) before sending "start", so a
    fallback from Soniox does not pay for the connection. Audio sent without
    a "start" starts a session at offset 0 (original behaviour)."""
    await ws.accept()
    engine: LocalSTTEngine | None = state["engine"]
    if engine is None:
        msg = state["engine_error"] or "Local engine not loaded"
        await ws.send_text(json.dumps({"type": "error", "message": msg}))
        await hub.status("error", "local", msg)
        await ws.close(code=1011)
        return

    async def send(obj: dict) -> None:
        try:
            await ws.send_text(json.dumps(obj))
        except Exception:
            pass

    async def on_event(ev: TranscriptEvent) -> None:
        if ev.final:
            await hub.add_final(ev.text, ev.start, ev.end, "local")
        else:
            await hub.add_partial(ev.text, ev.start, ev.end, "local")

    async def on_warning(message: str) -> None:
        await hub.status("processing", "local", message)

    sid: str | None = None

    async def start(offset: float) -> None:
        nonlocal sid
        if sid:
            await engine.end_session(sid, flush=False)
        sid = uuid.uuid4().hex[:8]
        await engine.start_session(sid, offset, on_event, send, on_warning)

    try:
        while True:
            m = await ws.receive()
            if m["type"] == "websocket.disconnect":
                break
            if m.get("bytes") is not None:
                if sid is None:
                    await start(0.0)
                await engine.push_audio(sid, m["bytes"])
                continue
            try:
                ctl = json.loads(m.get("text") or "{}")
            except json.JSONDecodeError:
                continue
            if ctl.get("type") == "start":
                await start(float(ctl.get("offset_seconds", 0.0)))
            elif ctl.get("type") == "stop":
                if sid:
                    await engine.end_session(sid, flush=True)
                    sid = None
                await send({"type": "done"})
                await ws.close()
                return
            elif ctl.get("type") == "abort":
                # Handing back to Soniox: it re-transcribes the unfinalised audio, so drop ours.
                if sid:
                    await engine.end_session(sid, flush=False)
                    sid = None
                await send({"type": "done"})
                await ws.close()
                return
    except WebSocketDisconnect:
        pass
    # Socket dropped without "stop": still transcribe what we have.
    if sid:
        await engine.end_session(sid, flush=True)


@app.post("/api/transcribe")
async def transcribe(request: Request):
    """One short clip (a spoken question): body is PCM s16le mono 16 kHz, reply is {"text": ...}.
    Always local Whisper, so a user's own voice never leaves this computer. It uses a batch model
    (the chunked engine's), which reads the whole clip at once instead of at real-time pace."""
    pcm = await request.body()
    if not pcm or len(pcm) > 16000 * 2 * 60:
        raise HTTPException(400, "Send 0-60 s of PCM s16le mono 16 kHz")
    try:
        batch = await _clip_engine()
    except ModelUnavailableError as e:
        raise HTTPException(503, str(e))
    t0 = time.perf_counter()
    segments = await asyncio.get_running_loop().run_in_executor(
        executor, batch.transcribe, pcm[: len(pcm) - len(pcm) % 2], 0.0
    )
    text = " ".join(" ".join(seg.text.split()) for seg in segments).strip()
    log.info("clip of %.1f s transcribed in %.1f s: %s", len(pcm) / 32000, time.perf_counter() - t0, text)
    return {"text": text}


@app.post("/api/tts")
async def tts(request: Request):
    """Read-aloud: {"text","language"} in, raw audio bytes out (Content-Type
    is whatever Soniox returned). 503 when cloud TTS isn't available right
    now - offline, not configured, local_only, or Soniox itself failed; the
    caller falls back to its on-device voice.

    No connectivity pre-check here (unlike /ws/stream): this is one short
    REST call, not a long session to steer up front, and tts_synthesize()
    already turns a network failure into TtsUnavailable on its own - probing
    first would just add a second round trip before every request, online or
    not."""
    body = await request.json()
    text = str(body.get("text", "")).strip()
    language = str(body.get("language", "tl"))
    if not text or len(text) > 1000:
        raise HTTPException(400, "text must be 1-1000 characters")
    if not settings.cloud_allowed:
        raise HTTPException(503, "STT_MODE=local_only: cloud TTS is disabled")
    if not settings.soniox_configured:
        raise HTTPException(503, "SONIOX_API_KEY is not set on the server")
    try:
        audio, mime_type = await tts_synthesize(settings, text, language)
    except TtsUnavailable as e:
        raise HTTPException(503, str(e))
    return Response(content=audio, media_type=mime_type)


_clip_lock = asyncio.Lock()


async def _clip_engine():
    """The batch model for spoken questions, loaded once (in the background at startup)."""
    async with _clip_lock:
        if state.get("clip_engine") is None:
            state["clip_engine"] = await asyncio.get_running_loop().run_in_executor(executor, create_engine, settings)
        return state["clip_engine"]


@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    """For backends: PCM in, transcripts out on this same socket. Soniox when
    online, the local engine otherwise, with fallback mid-stream. Protocol in
    app/stream.py."""
    await ws.accept()

    async def send(obj: dict) -> None:
        try:
            await ws.send_text(json.dumps(obj, ensure_ascii=False))
        except Exception:
            pass

    async def online() -> bool:
        return bool((await connectivity())["online"])

    stream = StreamSession(settings, state["engine"], hub, online, send)
    try:
        while True:
            m = await ws.receive()
            if m["type"] == "websocket.disconnect":
                break
            if m.get("bytes") is not None:
                await stream.push(m["bytes"])
                continue
            try:
                ctl = json.loads(m.get("text") or "{}")
            except json.JSONDecodeError:
                continue
            if ctl.get("type") == "start" and not stream.started:
                await stream.start(float(ctl.get("offset_seconds", 0.0)))
            elif ctl.get("type") == "simulate_offline":
                await stream.simulate_offline(bool(ctl.get("on", True)))
            elif ctl.get("type") == "stop":
                await stream.stop(flush=True)
                await send({"type": "done"})
                await ws.close()
                return
    except WebSocketDisconnect:
        pass
    await stream.stop(flush=False)
