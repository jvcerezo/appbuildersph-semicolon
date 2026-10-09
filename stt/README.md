# Linaw: speech pipeline

Speech-to-text for Linaw, which explains live legal and political broadcasts (for example a Philippine impeachment trial) in plain Tagalog. This repo covers **only** the STT pipeline and a temporary HTML test page. The LLM/RAG and the real frontend live elsewhere.

- **Online:** Soniox real-time (`stt-rt-v5`), streamed from the browser with a short-lived key. Secondary component.
- **Offline (core):** a local engine that runs with no internet at all:
  - **WhisperLiveKit** (default): real-time grey partial text that settles into black finals, like Soniox.
  - **chunked**: the original engine. faster-whisper on 5 s windows, finals only.
- Every engine produces **the same output format** on one WebSocket bus (`/ws/session`).

## Quick start (clone and run)

You need **Git**, **[uv](https://docs.astral.sh/uv/getting-started/installation/)** and **Chrome**.
uv installs the right Python version (see `.python-version`) for you. FFmpeg is **not** needed.

```powershell
# 1. Install uv (once per machine)
#    Windows (PowerShell):
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
#    macOS / Linux:
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Go to this folder
cd stt

# 3. Install dependencies into .venv (includes PyTorch for WhisperLiveKit, ~1 GB)
uv sync

# 4. Create your own .env from the template
copy .env.example .env        # Windows
cp .env.example .env          # macOS / Linux
#    Optional: open .env and set SONIOX_API_KEY=... for the online engine.
#    Without it, everything runs on the local engine.

# 5. Download the local models (needs internet, once; ~1 GB for "small" for both engines)
uv run scripts/download_models.py

# 6. Run
uv run main.py
```

Open http://127.0.0.1:8000/ in Chrome, pick a source, and press **Start**.

**What is not in the repo (on purpose):**
- `.env`: everyone creates their own from `.env.example`. Ask the team lead for a Soniox key; never commit it.
- `models/`: downloaded by step 5.
- `.venv/`: created by step 3.
- Audio and video clips: put test clips in `samples/` (also ignored).

If you get `ModuleNotFoundError`, you ran a bare `python` instead of `uv run`.
If the startup summary says `Local (offline): UNAVAILABLE`, repeat step 5. If you changed `WLK_MODEL` or `WHISPER_MODEL` in `.env`, step 5 must download that model.

## Architecture

How the pieces fit together (read this first if you are changing anything).

```
 Chrome tab / test file / mic
        │ getDisplayMedia / captureStream / getUserMedia
        ▼
 AudioWorklet (static/index.html): mono, 16 kHz, PCM s16le, 100 ms chunks
        │  + 20 s ring buffer (replayed to the next engine on a switch)
        │
        ├── online ──► wss://stt-rt.soniox.com  (browser ⇄ Soniox, temp key as subprotocol)
        │                 tokens → page groups into segments → posts to /ws/session
        │
        └── local ───► ws://…/ws/stt-local  (backend)
                          LocalSTTEngine (app/local_engine.py)
                          ├─ WhisperLiveKitEngine (app/wlk_engine.py)  partials + finals
                          └─ ChunkedEngine        (app/local_stream.py) finals every ~5 s
                          events → SessionHub (directly on the server)

 SessionHub (app/session.py): assigns ids, keeps the final transcript in memory,
 broadcasts transcript / status / metrics to every /ws/session client
        └► GET /api/session/transcript, GET /api/session/metrics
```

| Piece | File | Role |
|---|---|---|
| Config | `app/config.py` | Loads and validates `.env`. Holds the long-lived Soniox key server-side only |
| API + sockets | `app/main.py` | Routes, temp-key minting, `/ws/session` bus, `/ws/stt-local` engine sessions, startup summary |
| Session hub | `app/session.py` | Id sequence shared by all engines, transcript store, metrics, broadcast |
| Engine interface | `app/local_engine.py` | `LocalSTTEngine`: `start_session` / `push_audio` / `end_session`, emits `TranscriptEvent` |
| WhisperLiveKit | `app/wlk_engine.py`, `app/wlk_server.py` | Real-time local engine (embedded, or subprocess) and the mapping to our contract |
| Chunked engine | `app/local_stt.py`, `app/local_stream.py` | The original windowed faster-whisper engine, unchanged behind the new interface |
| Test page | `static/index.html` | Capture, Soniox client, mode switching and fallback, transcript, cloud meter, debug |

**Mode switching** lives in the page, because the Soniox socket lives there:
- At Start, the page picks an engine from the mode select:
  - **Auto** uses Soniox if the browser is online, `/api/connectivity` succeeds and a key exists. Otherwise it uses the local engine.
  - **Soniox** and **Local** force that engine.
  - **Local only** never touches the cloud.
- **Falling back mid-session:** if the Soniox socket errors or closes, the browser goes offline, Soniox sends nothing for 5 s and `/api/connectivity` fails (a dropped network often fires neither of the first two), or "Simulate offline" is clicked, the page switches to the local engine without stopping capture:
  1. It commits the text Soniox already finalised.
  2. It replays at most the last 6 s of audio from the ring buffer to the local engine, starting at that point.
  3. It sends live audio from then on.
- Timestamps are audio seconds since Start, so they stay continuous across the switch.
- **Switching back:** after a fallback caused by connectivity (not a rejected key) in Auto or Soniox mode, and also after an Auto start that found no internet, the page checks `/api/connectivity` every 5 s, backing off to 60 s after failures. Once a temporary key is obtained, it aborts the local session without flushing and replays audio from the last final to Soniox.

**Fast fallback:**
- The local engine is loaded and warmed up once at server start and stays warm.
- When a Soniox session starts, the page also pre-opens an idle `/ws/stt-local` socket (shown as "Local standby socket" in the debug panel). A fallback then only sends `start`, the replay and live audio. There is no model load and no new connection.
- Measured here: local partial text resumes about 1–2.5 s after the switch, depending on model size (see Known limits).

## Local engines

| `LOCAL_STT_ENGINE` | What you get |
|---|---|
| `whisperlivekit` (default) | Live partial text (grey, updating in place) and sentence-level finals. SimulStreaming (default) or LocalAgreement |
| `chunked` | The original engine: finals every ~5 s window (`LOCAL_CHUNK_SECONDS`), no partials. `faster-whisper` is accepted as an alias |
| `mlx-whisper` | The chunked engine on Apple Silicon |

Switch by editing `.env` and restarting the server. The startup summary and the page's debug panel both show what is loaded: engine, model, backend and integration. Run `uv run scripts/bench_local.py clip.mp4` to compare the engines on your laptop.

### WhisperLiveKit integration

**Approach: embedded (default, `WLK_EMBEDDED=true`).**
- One shared `TranscriptionEngine` is created at startup inside our FastAPI process. It loads the model and runs the warm-up.
- Each `/ws/stt-local` session gets its own `AudioProcessor(pcm_input=True, mode="diff")`.
- Audio goes in through `process_audio()`, and results are read from the `create_tasks()` generator.
- Inference runs in WhisperLiveKit's worker threads, so our event loop and bus stay responsive.

**Fallback approach: `WLK_EMBEDDED=false`.**
- `python -m app.wlk_server` runs WhisperLiveKit's own server on `127.0.0.1:WLK_PORT`, and each session proxies to its `/asr` WebSocket.
- It is slower to start and less precise (see Known limits). Use it only if the embedded path misbehaves.

**Where we follow WhisperLiveKit's actual behaviour instead of the original brief:**
- **Audio format:** WhisperLiveKit accepts raw PCM s16le 16 kHz (`pcm_input`, `--pcm-input`). We reuse the existing AudioWorklet chunks, so there is no second MediaRecorder/webm encoding and **no FFmpeg dependency**. The startup summary prints `FFmpeg: not needed (raw PCM input)`.
- **Warm-up:** the default warm-up downloads `jfk.wav` from the internet. We pass a locally generated clip (`models/wlk_warmup.wav`) instead.
- **Model files:** there is no single offline model folder for SimulStreaming. We pass explicit local paths: the faster-whisper encoder folder (`encoder_model_path`) and the decoder `<model>.pt` through `model_cache_dir`. Both are downloaded by `download_models.py`. The server also sets `HF_HUB_OFFLINE=1`, so nothing can be fetched at runtime.
- **Device:** WhisperLiveKit creates faster-whisper models with `device="auto"`. That picks a GPU even when cuBLAS is missing, then crashes. We pin the device from `WHISPER_DEVICE` (in `auto` we probe that cuBLAS actually loads) and `WHISPER_COMPUTE_TYPE`.
- **Partials with SimulStreaming:** SimulStreaming commits text directly, so its "unvalidated buffer" is usually empty. Our live grey line is the committed text of the sentence still in progress. It turns black (final) at a pause, at `.`, `?` or `!`, or after ~8 s. LocalAgreement also has a real unvalidated buffer, which is appended to the grey line.
- **Model choice:** multilingual models only. `.en` models do not work with SimulStreaming and cannot do Tagalog; config validation rejects them.
- **One configuration per process:** `TranscriptionEngine` is a process-wide singleton.

**Mapping to our contract** (`CommitSegmenter` in `app/wlk_engine.py`):
- Committed tokens become `final: true` segments. A segment closes at a WhisperLiveKit silence, at sentence-ending punctuation (3+ words), or after ~8 s at a word boundary.
- The open segment plus WhisperLiveKit's buffer is sent as `final: false`. The hub gives it the id its final will get, so the UI replaces it in place.
- Times are WhisperLiveKit's stream times plus the session offset, so they are absolute.

**Bounded memory and lag:**
- Sessions use WhisperLiveKit's diff mode, which keeps only 300 s of history.
- If WhisperLiveKit's queued audio exceeds 8 s, incoming audio is replaced by silence until the backlog is under 3 s. Silence is skipped cheaply by its VAD and timestamps stay continuous.
- This shows as "Local audio skipped" in the debug panel and as a `processing` status.

## Running the offline demo

1. **While online, before the venue:** `uv run scripts/download_models.py`. Then run `uv run scripts/bench_local.py <hearing clip>` to pick `WLK_MODEL` for that laptop.
2. In `.env`, set `STT_MODE=local_only` and `LOCAL_STT_ENGINE=whisperlivekit`. In `local_only` the backend also refuses every cloud call: `/api/connectivity` does no network request and `/api/soniox/temp-key` returns 403.
3. Turn Wi-Fi off and run `uv run main.py`. The summary shows `Soniox (online): OFF` and `Local (offline): available, whisperlivekit ...`.
4. Open http://127.0.0.1:8000/. The mode is "Local only", and the cloud modes are disabled in the dropdown.
5. Share the tab playing the hearing (tick "Share tab audio") and press **Start**:
   - The badge shows "Local · WhisperLiveKit".
   - Grey partial text appears within about 1–3 s and settles into black finals.
   - The Cloud meter shows 0 B sent.

To demo the switch instead:
1. Set `STT_MODE=auto` and a Soniox key, and stay online.
2. Start in Soniox mode.
3. Click **Simulate offline** mid-sentence. The badge flips to "Local · WhisperLiveKit" and text continues. Cloud bytes stop increasing from that moment.

## Using the test page

1. **Source:** pick one.
   - *Share a tab*: Chrome asks which tab to share. Pick the tab playing the hearing and **tick "Share tab audio"**. The video track is dropped right away.
   - *Use a test file*: choose an audio or video file. It plays in the page and audio is taken from `captureStream()`.
   - *Use microphone*: optional. It is not the default because the venue is noisy.
2. **Mode:** Auto / Soniox / Local / Local only. The default comes from `STT_MODE`.
3. **Start.** Final text shows in black and partial text from either engine in grey italics, updating in place. Each line has its time range and engine tag. The **engine badge** in the header flips when the engine changes.
4. The **Cloud meter** shows:
   - cloud bytes sent (audio sent to Soniox this session)
   - session time
   - average first-word latency
   - the cloud-only cost estimate
5. The **Debug** panel shows:
   - the audio level and chunks sent
   - latency per final segment
   - the local engine, model, backend and integration
   - the standby socket, real-time factor, backlog and audio skipped

## Testing each mode

| What | How | Expect |
|---|---|---|
| Soniox | `SONIOX_API_KEY` set, online, mode Auto or Soniox | Badge "Soniox cloud", segments tagged `soniox`, cloud bytes increasing |
| Local (WhisperLiveKit) | Mode Local or Local only | Badge "Local · WhisperLiveKit", grey partials then black finals tagged `local`, cloud bytes 0 |
| Local (chunked) | `LOCAL_STT_ENGINE=chunked`, restart | Same as before this upgrade: finals every ~5 s, no partials |
| Local only, no network | Wi-Fi off, `STT_MODE=local_only` | No network calls, no downloads, no errors |
| Mid-session fallback | Start with Soniox, click **Simulate offline** | Status "Switched to WhisperLiveKit: simulated offline". Capture keeps running, partials resume within ~2 s, timestamps keep increasing, badge flips |
| Real offline mid-session | Start with Soniox, then turn Wi-Fi off | Same as above, triggered by the browser `offline` event or the Soniox socket closing |
| Metrics | Watch `/ws/session`, or `curl localhost:8000/api/session/metrics` | A `metrics` message every ~2 s while capturing |
| Transcript API | `curl localhost:8000/api/session/transcript` | `{"session_id", "started_at", "segments": [...]}` |
| Engine comparison | `uv run scripts/bench_local.py clip.mp4` | Both engines on the same file at real-time pace, metrics and transcripts side by side |

## Output contract (for other teammates)

Connect to `ws://HOST:PORT/ws/session` and you receive:

```json
{ "type": "transcript", "id": "s12", "text": "...", "start": 312.4, "end": 318.9, "final": true, "engine": "soniox" }
{ "type": "status", "state": "listening", "engine": "local", "message": "..." }
{ "type": "metrics", "engine": "local", "cloud_bytes_sent": 0, "session_seconds": 312, "avg_first_word_latency_ms": 640, "cloud_cost_estimate": 0.0 }
```

- **Transcript and status messages are unchanged.** The `metrics` type is new; ignore it if you don't need it.
- **`start` and `end`** are seconds of captured audio since the session started, continuous across engine switches.
- **`final: false` lines** come from Soniox and from WhisperLiveKit. They carry the **same id** their final version will get, so replace by id. An empty `final: false` text means "clear the live line".
- **`state`** is one of `listening | processing | offline | audio_lost | error`.
- **`metrics`** is sent every ~2 s during a session, and once more at Stop:
  - `cloud_bytes_sent` counts audio bytes the page sent to Soniox; it stays 0 in local modes.
  - `session_seconds` is wall time since Start.
  - `cloud_cost_estimate` = `session_seconds × CLOUD_COST_PER_HOUR_ESTIMATE / 3600`. It is what a cloud-only version would have cost, shown for comparison.
  - `avg_first_word_latency_ms` is `null` until measured.
- **How first-word latency is measured:** whenever any text (partial or final) first covers new audio, the page takes the time since that audio chunk was captured and sent. "Covers new audio" means its `end` moves past what earlier text covered. The value is averaged over the session. After a switch, only audio captured after the switch counts, so the replay does not inflate it. It is approximate: it includes engine latency and the local hop, and assumes the engine's timestamps are accurate.
- **`GET /api/session/transcript`** returns final segments only. **`GET /api/session/metrics`** returns the latest `metrics` message.
- **The capturing page also sends** two messages on the bus: `{"type":"session_start"}`, which clears the in-memory transcript, and `{"type":"metrics_report", ...}` every ~2 s, which the server turns into `metrics`.

## API

| Route | Purpose |
|---|---|
| `GET /` | Test page (`static/index.html`) |
| `GET /api/config` | Public STT config: Soniox start message, local engine status (engine, model, backend, integration). Never contains the API key |
| `GET /api/connectivity` | Backend probes `CONNECTIVITY_CHECK_URL`. Skipped in `local_only` |
| `POST /api/soniox/temp-key` | Mints a single-use temporary key: `{api_key, expires_at}`. 403 in `local_only` |
| `GET /api/session/transcript` | Final segments of the current session |
| `GET /api/session/metrics` | Latest cloud-meter metrics |
| `WS /ws/session` | Unified transcript, status and metrics bus |
| `WS /ws/stt-local` | Text `{"type":"start","offset_seconds":X}`, then binary PCM s16le mono 16 kHz, then `{"type":"stop"}`. Replies with `stats` and `done`. A socket may stay idle (standby) before `start` |

## Configuration

See `.env.example` for every key. Notable ones:

- **`STT_MODE`:** `auto | soniox | local | local_only`. `local_only` disables all cloud calls on the backend too.
- **`LOCAL_STT_ENGINE`:** `whisperlivekit` (default) `| chunked | mlx-whisper`.
- **`WLK_MODEL`:** multilingual Whisper size (`tiny`, `base`, `small`, `medium`, `large-v3`, `turbo`). **`WLK_BACKEND`:** `simulstreaming` (lowest latency) or `localagreement`. **`WLK_LANGUAGE`:** empty for auto, or `tl` / `en`.
- **`WLK_MODEL_CACHE_DIR`:** where the WhisperLiveKit weights live (`./models`). **`WLK_EMBEDDED`** / **`WLK_PORT`:** the integration mode (see above).
- **`WLK_DIARIZATION`:** speaker labels. They need extra diarization models that `download_models.py` does not fetch, so keep it `false` for offline use.
- **`WHISPER_MODEL`, `LOCAL_CHUNK_SECONDS`, `LOCAL_CHUNK_OVERLAP_SECONDS`, `WHISPER_LANGUAGE`:** the chunked engine.
- **`WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE`:** device and precision for both engines' faster-whisper models. With `auto`, CUDA is used only if cuBLAS actually loads; otherwise the CPU is used.
- **`CLOUD_COST_PER_HOUR_ESTIMATE`:** our own comparison figure (USD per hour) for the cloud meter.
- **`content/stt_terms.json`:** domain terms sent to Soniox as `context.terms` (a list, or `{"terms": [...]}`).

## Security notes

- `SONIOX_API_KEY` is used in exactly one place: the `Authorization` header of the server-side temp-key request. It is never returned, logged (errors log only the HTTP status), or included in `/api/config`.
- The browser authenticates to Soniox with the temp key as a WebSocket subprotocol (`["soniox-api-key", key]`). The start message contains no `api_key`.
- Temp keys are `single_use` and expire after `SONIOX_TEMP_KEY_TTL_SECONDS`.
- `.env` is in `.gitignore`. Before pushing, run `git status` and make sure `.env` is **not** listed.
- If a real key is ever committed or pushed, **revoke it in the Soniox console right away** and create a new one. Deleting the file in a later commit does not remove it from git history.

## Known limits

- **Tab audio needs Chrome** (or Edge), and the user must tick "Share tab audio". Firefox and Safari can use the file or mic source.
- **WhisperLiveKit speed depends heavily on the laptop.** Measured on the dev laptop (CPU only, int8, no usable CUDA), with a 38 s English clip at real-time pace:

  | Engine / model | Real-time factor | First partial | Partial after a fallback | Final lag |
  |---|---|---|---|---|
  | WhisperLiveKit `tiny` | ~0.94 | ~1.1 s | ~0.3 s | ~2–4 s |
  | WhisperLiveKit `small` | ~0.97–1.0 (saturated) | ~2.5 s | ~2.6 s | ~4 s |
  | chunked `small` | ~0.64 | finals only, ~7.5 s | n/a | ~6.4 s |

  Run `bench_local.py` on the demo machine and pick the largest model whose real-time factor stays below ~0.8. A CUDA GPU makes `small` or `medium` comfortable.
- **When the local engine falls behind**, audio is skipped to stay live. Skipped speech is not transcribed. The debug panel and a `processing` status show it.
- **SimulStreaming finals are sentence-based.** Speech with no punctuation and no pauses becomes final only every ~8 s. Until then it is visible as grey partial text.
- **Subprocess mode (`WLK_EMBEDDED=false`)** gets line text without per-token timings. Sub-segment timestamps are coarser, there is no backlog guard on our side, and a single line longer than 300 s without a pause can produce a duplicated segment. Prefer the embedded mode.
- **Chunked engine latency is about one window** (5 s) plus inference time, with no partials. Kept for comparison and as a fallback.
- **Local accuracy depends on model size.** `tiny` and `base` struggle with Tagalog and Taglish. `small` is the minimum we recommend, `medium` or `turbo` if the laptop can keep up. Language auto-detection may pick the wrong language on code-switched speech; set `WLK_LANGUAGE=tl` if needed.
- **Disk and install size:** WhisperLiveKit pulls in PyTorch (~1 GB). The `small` model needs ~460 MB of decoder weights plus ~480 MB of encoder.
- **Latency figures are approximate.** First-word latency and per-segment latency are measured in the page from capture time.
- **One capture session at a time** is the intended use. The bus, transcript and metrics are global and in memory, and are lost on restart.
- **The resampler is a simple box filter.** It is fine for speech STT but not for high-fidelity audio.
- **Soniox token timestamps** (`start_ms` and `end_ms`) are used when present. Otherwise segment times fall back to `final_audio_proc_ms`.
- **The Soniox path and the browser page were not exercised end to end in development:** there was no Soniox key and no browser automation. The local engines, the bus, metrics and the transcript endpoint were tested with scripted clients. Run the acceptance tests in Chrome before the demo.
