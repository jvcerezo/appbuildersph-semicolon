# Linaw backend

Hears the hearing and explains its legal terms. ffmpeg decodes the UI's audio, the speech service in [`stt/`](../stt/README.md) turns it into text (Soniox when online, local Whisper when not), and Ollama writes the explanations. It serves the contract on `ws://localhost:8765`, so the UI works with it unchanged.

Plan, decisions and the glossary format: [`docs/backend-plan.md`](../docs/backend-plan.md).

## Setup (Windows, once)

1. Node 20+ and pnpm 12 (`npm i -g pnpm@12.10.1`), then `pnpm install` at the repo root.
2. ffmpeg: `winget install Gyan.FFmpeg`, then open a new terminal.
3. Ollama, in PowerShell: `irm https://ollama.com/install.ps1 | iex`, then `ollama pull gemma3:4b`.
4. The speech service: install [uv](https://docs.astral.sh/uv/getting-started/installation/), run `pnpm stt:setup` (Python packages and the ~1 GB Whisper model, once), then copy `stt/.env.example` to `stt/.env` and set `SONIOX_API_KEY`. Without a key it runs on local Whisper only.

## Run

```sh
pnpm stt                     # speech service; leave it running
pnpm backend                 # prints a checklist of what it found
pnpm dev:overlay:backend     # or overlay window + UI + speech service + backend together
```

Settings live in `.env` (copy `.env.example`): ports, the ffmpeg path, the speech engine, and the Ollama model. `STT=whisper-server` switches back to whisper.cpp only (download `whisper-bin-x64.zip` from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and `ggml-small.bin` from [Hugging Face](https://huggingface.co/ggml-org/whisper.cpp), then run `whisper-server -m ggml-small.bin --host 127.0.0.1 --port 8178`). To try a smarter model, `ollama pull gemma4:e4b` and set `OLLAMA_MODEL=gemma4:e4b`.

## Speech to text

The backend streams each session's audio to the speech service and gets lines back as they are spoken: draft text while a sentence is in progress (`final: false`), then the final line, which is what glossary terms and cards are found in. If the internet drops, the service switches to local Whisper on its own and the UI shows "Offline mode — still working"; it switches back when the internet returns. Details: [`stt/README.md`](../stt/README.md).

## Check it

```sh
pnpm --filter @linaw/backend replay fixtures/mock-hearing-tts.webm         # print what the UI would get, no UI needed
pnpm conformance --audio ../../backend/fixtures/mock-hearing-tts.webm --fast  # the contract checker, with the backend running
pnpm validate                                                              # includes the glossary
```

## Glossary

`glossary/terms.json`: every entry becomes a **Checked** card, so only add explanations someone has checked. The AI writes only the "Right now" line. Terms outside the glossary aren't explained yet; AI-explained cards are the next phase.
