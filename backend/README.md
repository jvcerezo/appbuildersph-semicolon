# Linaw backend

Hears the hearing and explains its legal terms. ffmpeg decodes the UI's audio, the speech service in [`stt/`](../stt/README.md) turns it into text (Soniox when online, local Whisper when not), and Ollama writes the explanations. It serves the contract on `ws://localhost:8765`, so the UI works with it unchanged.

Plan, decisions and the glossary format: [`docs/backend-plan.md`](../docs/backend-plan.md).

## Setup (Windows, once)

1. Node 20+ and pnpm 12 (`npm i -g pnpm@12.10.1`), then `pnpm install` at the repo root.
2. ffmpeg: `winget install Gyan.FFmpeg`, then open a new terminal.
3. Ollama, in PowerShell: `irm https://ollama.com/install.ps1 | iex`, then `ollama pull gemma4:e4b`.
4. The speech service: install [uv](https://docs.astral.sh/uv/getting-started/installation/), run `pnpm stt:setup` (Python packages and the ~1 GB Whisper model, once), then copy `stt/.env.example` to `stt/.env` and set `SONIOX_API_KEY`. Without a key it runs on local Whisper only.

## Run

```sh
pnpm stt                     # speech service; leave it running
pnpm backend                 # prints a checklist of what it found
pnpm dev:overlay:backend     # or overlay window + UI + speech service + backend together
```

Settings live in `.env` (copy `.env.example`): ports, the ffmpeg path, the speech engine, and the Ollama model. For faster but less accurate answers, `ollama pull gemma3:4b` and set `OLLAMA_MODEL=gemma3:4b`. `STT=whisper-server` switches back to whisper.cpp only (download `whisper-bin-x64.zip` from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and `ggml-small.bin` from [Hugging Face](https://huggingface.co/ggml-org/whisper.cpp), then run `whisper-server -m ggml-small.bin --host 127.0.0.1 --port 8178`).

## Speech to text

The backend streams each session's audio to the speech service and gets lines back as they are spoken: draft text while a sentence is in progress (`final: false`), then the final line, which is what glossary terms and cards are found in. If the internet drops, the service switches to local Whisper on its own and the UI shows "Offline mode — still working"; it switches back when the internet returns. Details: [`stt/README.md`](../stt/README.md).

## Law library

Ask answers questions about the law from `law/passages.json`: 610 short, cited passages of Philippine law and rules, searched offline (keyword ranking with a Tagalog-to-English word list, so "Sino ang puwedeng ma-impeach?" finds Const. Art. XI, Sec. 2). The answer explains the passage in plain words and Linaw adds the citation itself, from the passage the answer matches, so a section number is never invented.

| Source | Version |
|---|---|
| 1987 Constitution | as ratified |
| Revised Rules on Evidence (Rules 128-134) | 2019 amendments, in force since May 1, 2020 |
| Rules of Court, Rule 21 (Subpoena) | 1997 Rules of Civil Procedure |
| Senate Rules of Procedure on Impeachment Trials | 2011 (Resolution No. 39, 15th Congress); check for later revisions |
| RA 3019, Anti-Graft and Corrupt Practices Act | as on LawPhil |
| RA 6713, Code of Conduct and Ethical Standards | as enacted |

The texts are Philippine government works, which carry no copyright (IP Code, Sec. 176); they are taken from LawPhil. To add a source or refresh the texts, edit `scripts/build-law.ts` and run `pnpm --filter @linaw/backend build-law` (needs internet; the result is committed so Linaw stays offline).

## Case brief

The AI gets a short background paragraph about the hearing with every Summary, "What did they say?", Ask and "Right now" request, from `briefs/`. `CASE_BRIEF` in `.env` lists which ones (default `impeachment-trial`, how a Senate impeachment trial works, taken from the law library's sources). For a demo clip, copy `briefs/example-hearing.json` to e.g. `briefs/day-3.json`, fill in who is on trial, the charges and who speaks, and set `CASE_BRIEF=impeachment-trial,day-3`. The brief is background only: summaries still say only what the transcript says. The backend refuses to start if a brief still has `[placeholders]`.

## Check it

```sh
pnpm --filter @linaw/backend replay fixtures/mock-hearing-tts.webm         # print what the UI would get, no UI needed
pnpm conformance --audio ../../backend/fixtures/mock-hearing-tts.webm --fast  # the contract checker, with the backend running
pnpm validate                                                              # includes the glossary
```

## Glossary

`glossary/terms.json`: every entry becomes a **Checked** card, so only add explanations someone has checked. The AI writes only the "Right now" line.

`glossary/watchlist.json`: legal terms with no checked explanation. When one is said, the AI writes an **AI-explained** card. Add a term here when it should get a card but nobody has checked Tagalog for it yet; move it to `terms.json` once someone has.
