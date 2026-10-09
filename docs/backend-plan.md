# Backend plan

The real backend: it listens to the hearing audio, writes the transcript, spots legal terms and explains them, all on this computer. It speaks the same contract as `tools/demo-backend`, so the UI doesn't change. Setup and commands: [`backend/README.md`](../backend/README.md).

Owner: Gabb. Demo deadline: under 24 hours from 2026-10-09 16:00 PHT.

## How it works

```
UI / overlay  ──1-second webm/opus audio + JSON requests──▶  backend (ws://127.0.0.1:8765)
                                                               ├─ ffmpeg          webm → 16 kHz PCM
                                                               ├─ speech service  PCM → draft and final lines → transcript.segment
                                                               │    (stt/, ws://127.0.0.1:8000: Soniox online, WhisperLiveKit offline)
                                                               │    or STT=whisper-server: pause cutter → whisper.cpp
                                                               ├─ finder          glossary, watch-list terms → card (drafts) / card.pending
                                                               └─ Ollama          "Right now", explanations, help answers
```

Everything runs on this computer except Soniox, which the speech service uses while online (CLAUDE.md rule 2). Offline, or with `STT_MODE=local_only`, nothing leaves the machine: the speech service on 127.0.0.1:8000, `whisper-server` on 127.0.0.1:8178 when used, and Ollama on 127.0.0.1:11434.

## Phases

Order follows the team's task list: "What did they say?" matters most for the demo, and the AI stays off the card path.

| # | Phase | Shows on screen | Scope | Status |
|---|---|---|---|---|
| 0 | Setup: Ollama, ffmpeg, whisper.cpp, test clips | each tool works alone | must | done (real demo clips still needed) |
| 1 | Skeleton backend | UI connects | must | done |
| 2 | Ears | live transcript | must | done |
| 3 | Checked cards from the glossary, and Simpler | underlined terms, Checked cards | must | done (5 seed terms; glossary pending) |
| 4 | Instant cards: the glossary card shows at once, "Right now" fills in a moment later | cards with no wait | must | done |
| 5 | What did they say? | help panel answers | must | done (~11 s on gemma4:e4b; up to 3 points, one AI call each) |
| 6 | Summary, including the final one saved after Stop | Summary panel, library | must | done (~6.5 s; events for every 6 lines are written in the background) |
| 7 | Ask, with RAG over the rules | Ask panel answers | should | done: transcript, glossary and the law library (6 sources, 610 cited passages, offline keyword search); Linaw adds the citation |
| 8 | Fuzzy term matching | terms found even when misheard | should | done (re-check on the real clips) |
| 9 | AI-explained cards for terms not in the glossary | more cards | could | done (watch list ~5–9 s per card; spotter when the AI is idle) |
| 9b | Merge the team's work: speech service (`stt/`), law library, case briefs, translation | grey draft lines, offline switch, cited Ask answers | must | done: conformance 14 passed on both `STT=whisper-server` and `STT=service`. Without a Soniox key the service's local engine (WhisperLiveKit `small`, CPU) falls 10–50 s behind on this PC and skips audio, which garbles lines (D15) |
| 9c | Watch-list drafts (D14): AI cards written ahead of time | every listed term's card shows at once | should | done (37 drafts; "Right now" follows in 3–4 s; teammate still to check them) |
| 10 | Demo prep: real clips, D7 test, glossary from the clips, disclosures, two clean rehearsals, backup video | ready to present | must | |
| 11 | Speed tune-ups: card cache on disk, Ollama context size, whisper.cpp threads | faster cards and fallback | could | after Phase 10 |

`pnpm conformance --audio ../../backend/fixtures/mock-hearing-tts.webm --fast`: 14 passed, 0 failed. With `--fast` (audio ~10× real time) the last AI cards can still be writing when the checker hangs up, so it may warn about unresolved `card.pending`; at real speed they all arrive.

Every prompt says an objection is not a ruling, because gemma3:4b kept reading "Objection" as the court rejecting a motion. That and Ask's mistakes led to switching to gemma4:e4b (D6).

Replay of the test hearing: "articles of impeachment" is said at 0:06, its line and full Checked card show 2.8 s later, and the AI's "Right now" line replaces the plain one about 2 s after that.

## Teammates' work

- **jvcerezo**: UI, overlay, contract, demo backend. Contract changes go through the `linaw-contract` skill and their review. The demo backend is the fallback if the real backend fails on stage. Also the speech service in `stt/` (and its term list `stt/content/stt_terms.json`), the law library behind Ask (`backend/law/`), case briefs (`backend/briefs/`, `CASE_BRIEF`) and line translation.
- **Glossary teammate** (D3): the first 30–40 terms, starting with the demo clips. `backend/glossary/drafts.json` holds AI drafts for the watch list to check and move into `terms.json`.
- **Open questions for the team**: is the demo laptop this PC (D6 was measured here)? Which rules does Ask search?

## Decisions log

| ID | Decision | Answer | Date |
|---|---|---|---|
| D1 | Backend language and location | TypeScript in `backend/` (moved from `apps/backend` to match `docs/backend.md`), inside the pnpm workspace | 2026-10-09 |
| D2 | How the demo plays the hearing | Desktop overlay listening to system audio while a saved hearing video plays (works with Wi-Fi off). Team picks 2 clips with many legal terms. | 2026-10-09 |
| D3 | Who writes the glossary | A teammate writes the Tagalog entries (format below) | 2026-10-09 |
| D4 | AI fails after "Explaining…" shows | Add a `card.failed` contract message and the UI change; Gabb's side writes it, UI teammate reviews. Done with Phase 9 (contract, UI and conformance; jvcerezo to review). | 2026-10-09 |
| D5 | Speech-to-text model | The team's speech service (`STT=service`, default): Soniox online, WhisperLiveKit `small` offline, switching mid-session. `STT=whisper-server` keeps the first setup: Whisper `small` on the CPU with a legal-term hint (~2.5 s per sentence). | 2026-10-10 |
| D6 | AI model | `gemma4:e4b` (switched from `gemma3:4b` the same night). gemma3:4b was faster but kept inventing rulings (an objected motion reported as rejected); gemma4:e4b got them right. Costs on this PC: "Right now" ~3 s, What did they say? ~11 s, Summary ~6.5 s. Swappable with `OLLAMA_MODEL`; re-check on the demo laptop if it isn't this PC. | 2026-10-09 |
| D7 | Whisper language | open — test `auto` vs `en` on a real demo clip | |
| D8 | AI-written "Right now" on Checked cards | Keep the Checked badge; the UI teammate is told the AI writes that one line | 2026-10-09 |
| D9 | Terms not in the glossary | Watch list (`glossary/watchlist.json`, terms with no explanation) plus an AI spotter. Watch-list terms show "Explaining…" at once, then an AI card or `card.failed`. The spotter runs only when the AI is idle, and a spotted term shows nothing until its card is ready and the AI confirms it is jargon; then the line is re-sent with the term. | 2026-10-10 |
| D10 | Simple vs Detailed | Detailed makes the AI-written meaning 2–3 sentences; "Right now" stays one sentence; Checked cards keep their glossary text. New cards only. | 2026-10-10 |
| D11 | Legal-advice or off-topic questions in Ask | Explain, then redirect: a keyword check (Tagalog and English) catches advice and predictions, and the answer always starts with a fixed "no legal advice, see a lawyer or the PAO" line before the AI explains the related term or step. Off-topic questions get a fixed line. | 2026-10-09 |
| D12 | Top-bar title | The AI writes a short title with each summary (button or final), sent with `status`. Until then the UI's date-based name stays. | 2026-10-09 |
| D13 | "Offline mode" pill | The speech service reports when it falls back to local Whisper; the backend sends `status: offline`. | 2026-10-10 |
| D14 | Watch-list cards are slow (5–36 s live) | The AI writes drafts ahead of time (`pnpm --filter @linaw/backend draft-cards` → `glossary/drafts.json`). A listed term with a draft shows its full **AI-explained** card at once and only "Right now" is written live, like Checked cards. No draft → the D9 live path. The glossary teammate checks drafts and moves them into `terms.json`. | 2026-10-10 |
| D15 | Speech-to-text when offline | open — WhisperLiveKit on the CPU can't keep up on this PC. Options: its GPU mode (competes with gemma4:e4b for the 6 GB), or `STT=whisper-server` for an offline demo (~2–3 s per sentence, accurate). Decide with jvcerezo. | |

Defaults unless someone objects: the speaker is shown as "Speaker"; grey draft lines while a sentence is being spoken (from the speech service); a repeated term links to its existing card; "Simpler" on a Checked card makes it AI-explained; Summary reads the whole transcript; a language switch affects only new items.

## Glossary format (for the teammate writing it)

File: `backend/glossary/terms.json`. Every entry here shows as a **Checked** card, so only add explanations someone has checked.

```json
{
  "terms": [
    {
      "id": "subpoena",
      "term": "Subpoena",
      "aliases": ["subpoenas", "subpena"],
      "tl": {
        "meaning": "Utos ng korte na humarap ang isang tao o magdala ng dokumento.",
        "example": "Parang opisyal na imbitasyon na hindi puwedeng tanggihan nang walang dahilan."
      },
      "en": {
        "meaning": "A court order to appear or to bring documents.",
        "example": "Like an official invitation you can't turn down without a good reason."
      },
      "source": "Who wrote or checked it, or where it came from"
    }
  ]
}
```

- `id`: lowercase, words joined by `-`, unique.
- `term`: the card title.
- `aliases`: other ways the term is said or misheard (plurals, spellings, Tagalog forms). Matching ignores capital letters.
- `tl` is required: `meaning` is one short sentence in everyday Tagalog; `example` is an everyday comparison, usually starting with "Parang…". `en` is optional.
- Never tell the user what to do legally. Explain the term only.
- The "Right now" line is not in the glossary. It depends on the moment, so the AI writes it from what was just said.
- Aim for 30–40 terms: every legal term in the demo clips first, then the common ones (objection, sustained, overruled, hearsay, witness, testimony, quorum, recess…).
