# Disclosures

## Speech-to-text pipeline

| Component | Role | Runs | License |
|---|---|---|---|
| Soniox real-time STT, model `stt-rt-v5` | Online transcription (secondary component, used only when internet is available) | Cloud (Soniox) | Commercial API |
| WhisperLiveKit (QuentinFuxa/WhisperLiveKit), SimulStreaming backend (AlignAtt policy; LocalAgreement optional), multilingual Whisper `small` by default (`WLK_MODEL`), faster-whisper encoder + PyTorch Whisper decoder | Primary offline transcription with real-time partial text (core, works without internet) | Local, embedded in the backend | Apache-2.0 (WhisperLiveKit), MIT (Whisper weights) |
| faster-whisper (SYSTRAN) with OpenAI Whisper weights, default size `small` (int8), configurable via `WHISPER_MODEL` | Chunked offline engine (`LOCAL_STT_ENGINE=chunked`), and the encoder inside WhisperLiveKit | Local | MIT (faster-whisper, Whisper weights) |
| CTranslate2 | Inference runtime for faster-whisper | Local | MIT |
| PyTorch, torchaudio | Whisper decoder runtime for WhisperLiveKit SimulStreaming | Local | BSD-3-Clause |
| Silero VAD (bundled in faster-whisper and WhisperLiveKit, via onnxruntime) | Skips silence before transcription | Local | MIT |
| onnxruntime | Runs Silero VAD | Local | MIT |
| soundfile, librosa, SciPy (WhisperLiveKit dependencies) | Warm-up clip I/O and audio utilities | Local | BSD-3-Clause / ISC / BSD-3-Clause |
| mlx-whisper (optional, Apple Silicon) | Alternative chunked local engine | Local | MIT |
| FastAPI | Backend web framework | Local | MIT |
| Uvicorn | ASGI server | Local | BSD-3-Clause |
| httpx | Backend HTTP client (Soniox temp keys, connectivity check) | Local | BSD-3-Clause |
| websockets | WebSocket support for Uvicorn, and the WhisperLiveKit subprocess proxy | Local | BSD-3-Clause |
| python-dotenv | Loads `.env` configuration | Local | BSD-3-Clause |
| NumPy | Audio buffer conversion | Local | BSD-3-Clause |
| huggingface_hub | One-time model download (`scripts/download_models.py`), never at runtime | Local | Apache-2.0 |
| PyAV (dependency of faster-whisper) | Decodes audio files in `scripts/bench_local.py` | Local | BSD-3-Clause |

Browser side: Web Audio API (AudioWorklet), `getDisplayMedia` / `captureStream`. No third-party JavaScript libraries. Icons are inline SVG drawn in the style of Lucide (ISC license).
