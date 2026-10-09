# Backend plan

The real backend: it listens to the hearing audio, writes the transcript, spots legal terms and explains them, all on this computer. It speaks the same contract as `tools/demo-backend`, so the UI doesn't change. Setup and commands: [`backend/README.md`](../backend/README.md).

Owner: Gabb. Demo deadline: under 24 hours from 2026-10-09 16:00 PHT.

## How it works

```
UI / overlay  ──1-second webm/opus audio + JSON requests──▶  backend (ws://127.0.0.1:8765)
                                                               ├─ ffmpeg      webm → 16 kHz PCM
                                                               ├─ cutter      splits at pauses
                                                               ├─ whisper.cpp clip → text      → transcript.segment
                                                               ├─ finder      glossary terms   → card.pending
                                                               └─ Ollama      explanations     → card, help answers
```

Everything runs locally: ffmpeg, `whisper-server` on 127.0.0.1:8178, and Ollama on 127.0.0.1:11434.

## Phases

Order follows the team's task list: "What did they say?" matters most for the demo, and the AI stays off the card path.

| # | Phase | Shows on screen | Scope | Status |
|---|---|---|---|---|
| 0 | Setup: Ollama, ffmpeg, whisper.cpp, test clips | each tool works alone | must | done (real demo clips still needed) |
| 1 | Skeleton backend | UI connects | must | done |
| 2 | Ears | live transcript | must | done |
| 3 | Checked cards from the glossary, and Simpler | underlined terms, Checked cards | must | done (5 seed terms; glossary pending) |
| 4 | Instant cards: the glossary card shows at once, "Right now" fills in a moment later | cards with no wait | must | done |
| 5 | What did they say? | help panel answers | must | done (~6 s; up to 3 points, one AI call each) |
| 6 | Summary, including the final one saved after Stop | Summary panel, library | must | done (~5 s; events for every 6 lines are written in the background) |
| 7 | Ask, with RAG over the rules | Ask panel answers | should | done from the transcript and glossary; rules search waits for the rules text |
| 8 | Fuzzy term matching | terms found even when misheard | should | next (best tuned on the real clips) |
| 9 | AI-explained cards for terms not in the glossary | more cards | could | later |
| 10 | Demo prep: real clips, D7 test, glossary from the clips, disclosures, two clean rehearsals, backup video | ready to present | must | |

`pnpm conformance --audio ../../backend/fixtures/mock-hearing-tts.webm --fast`: 14 passed, 0 failed, 0 warnings.

Known weakness of gemma3:4b: it sometimes invents rulings (reads "Objection" as the court rejecting a motion). A rule in every prompt fixed it in Summary and What did they say?, but Ask still slips. Worth comparing gemma4:e4b on the help answers when tuning D6.

Replay of the test hearing: "articles of impeachment" is said at 0:06, its line and full Checked card show 2.8 s later, and the AI's "Right now" line replaces the plain one about 2 s after that.

## Teammates' work

- **jvcerezo**: UI, overlay, contract, demo backend. Contract changes go through the `linaw-contract` skill and their review. The demo backend is the fallback if the real backend fails on stage.
- **Glossary teammate** (D3): the first 30–40 terms, starting with the demo clips.
- **Open questions for the team**: is the demo laptop this PC (D6 was measured here)? Which rules does Ask search?

## Decisions log

| ID | Decision | Answer | Date |
|---|---|---|---|
| D1 | Backend language and location | TypeScript in `backend/` (moved from `apps/backend` to match `docs/backend.md`), inside the pnpm workspace | 2026-10-09 |
| D2 | How the demo plays the hearing | Desktop overlay listening to system audio while a saved hearing video plays (works with Wi-Fi off). Team picks 2 clips with many legal terms. | 2026-10-09 |
| D3 | Who writes the glossary | A teammate writes the Tagalog entries (format below) | 2026-10-09 |
| D4 | AI fails after "Explaining…" shows | Add a `card.failed` contract message and the UI change; Gabb's side writes it, UI teammate reviews. Lands with Phase 9: from Phase 4 on, Checked cards never wait on the AI. | 2026-10-09 |
| D5 | Speech-to-text model | Whisper `small` on the CPU, with a legal-term hint (~2.5 s per sentence, transcribed the test hearing perfectly) | 2026-10-09 |
| D6 | AI model | `gemma3:4b` for now (fastest, ~2.5 s per card). Swappable with `OLLAMA_MODEL`. In tests `gemma4:e4b` was the most accurate (~4–5 s per card, "write the English meaning first" prompt); try it when optimizing. | 2026-10-09 |
| D7 | Whisper language | open — test `auto` vs `en` on a real demo clip | |
| D8 | AI-written "Right now" on Checked cards | Keep the Checked badge; the UI teammate is told the AI writes that one line | 2026-10-09 |
| D9 | Terms not in the glossary | open (Phase 9) | |
| D10 | Simple vs Detailed | open (Phase 9) | |
| D11 | Legal-advice or off-topic questions in Ask | Explain, then redirect: a keyword check (Tagalog and English) catches advice and predictions, and the answer always starts with a fixed "no legal advice, see a lawyer or the PAO" line before the AI explains the related term or step. Off-topic questions get a fixed line. | 2026-10-09 |
| D12 | Top-bar title | The AI writes a short title with each summary (button or final), sent with `status`. Until then the UI's date-based name stays. | 2026-10-09 |
| D13 | "Offline mode" pill | open (Phase 10) | |

Defaults unless someone objects: the speaker is shown as "Speaker"; no live "typing" lines; a repeated term links to its existing card; "Simpler" on a Checked card makes it AI-explained; Summary reads the whole transcript; a language switch affects only new items.

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
