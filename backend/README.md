# Linaw backend

Hears the hearing and explains its legal terms, all on this computer. ffmpeg decodes the UI's audio, whisper.cpp turns speech into text, and Ollama writes the explanations. It serves the contract on `ws://localhost:8765`, so the UI works with it unchanged.

Plan, decisions and the glossary format: [`docs/backend-plan.md`](../docs/backend-plan.md).

## Setup (Windows, once)

1. Node 20+ and pnpm 12 (`npm i -g pnpm@12.10.1`), then `pnpm install` at the repo root.
2. ffmpeg: `winget install Gyan.FFmpeg`, then open a new terminal.
3. Ollama, in PowerShell: `irm https://ollama.com/install.ps1 | iex`, then `ollama pull gemma3:4b`.
4. whisper.cpp: download `whisper-bin-x64.zip` from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and the `ggml-small.bin` model from [Hugging Face](https://huggingface.co/ggml-org/whisper.cpp). Keep both outside the repo.

## Run

```sh
whisper-server -m ggml-small.bin --host 127.0.0.1 --port 8178   # speech to text; leave it running
pnpm backend                 # prints a checklist of what it found
pnpm dev:overlay:backend     # or overlay window + UI + backend together
```

Settings live in `.env` (copy `.env.example`): ports, the ffmpeg path, the Whisper language, and the Ollama model. To try a smarter model, `ollama pull gemma4:e4b` and set `OLLAMA_MODEL=gemma4:e4b`.

## Check it

```sh
pnpm --filter @linaw/backend replay fixtures/mock-hearing-tts.webm         # print what the UI would get, no UI needed
pnpm conformance --audio ../../backend/fixtures/mock-hearing-tts.webm --fast  # the contract checker, with the backend running
pnpm validate                                                              # includes the glossary
```

## Glossary

`glossary/terms.json`: every entry becomes a **Checked** card, so only add explanations someone has checked. The AI writes only the "Right now" line. Terms outside the glossary aren't explained yet (Phase 9 in the plan).
