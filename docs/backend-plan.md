# Backend plan

The backend replaces `tools/mock-server` with the real thing: it listens to the hearing audio, writes the transcript, spots legal terms and explains them, all on this computer. It speaks the same contract as the mock, so the UI doesn't change.

Owner: Gabb. Demo deadline: under 24 hours from 2026-10-09 16:00 PHT.

## How it works

```
UI / overlay  ──1-second webm/opus audio + JSON requests──▶  apps/backend (ws://127.0.0.1:8765)
                                                               ├─ ffmpeg      webm → 16 kHz PCM
                                                               ├─ cutter      splits at pauses
                                                               ├─ whisper.cpp clip → text      → transcript.segment
                                                               ├─ finder      glossary terms   → card.pending
                                                               └─ Ollama      explanations     → card, help answers
```

Everything runs locally: ffmpeg, `whisper-server` on 127.0.0.1:8178, and Ollama on 127.0.0.1:11434.

## Phases

| # | Phase | Shows on screen | Scope |
|---|---|---|---|
| 0 | Setup: Ollama, ffmpeg, whisper.cpp, test clips | each tool works alone | must |
| 1 | Skeleton backend | UI connects, "Waiting for audio" | must |
| 2 | Ears | live transcript | must |
| 3 | Checked cards from the glossary | underlined terms, Checked cards | must |
| 4 | AI-explained cards | cards for terms not in the glossary | must |
| 5 | What did they say? → Summary → Ask → Simpler | help panels answer | should |
| 6 | Demo prep: two clean rehearsals, backup video | ready to present | must |

## Decisions log

| ID | Decision | Answer | Date |
|---|---|---|---|
| D1 | Backend language and location | TypeScript, `apps/backend` in this repo | 2026-10-09 |
| D2 | How the demo plays the hearing | Desktop overlay listening to system audio while a saved hearing video plays (works with Wi-Fi off). Team picks 2 clips with many legal terms. | 2026-10-09 |
| D3 | Who writes the glossary | A teammate writes the Tagalog entries (format below) | 2026-10-09 |
| D4 | AI fails after "Explaining…" shows | Add a `card.failed` contract message and the UI change; Gabb's side writes it, UI teammate reviews | 2026-10-09 |
| D5 | Speech-to-text model | Whisper `small` on the CPU, with a legal-term hint (~2.5 s per sentence, transcribed the test hearing perfectly) | 2026-10-09 |
| D6 | AI model | `gemma3:4b` for now (fastest, ~2.5 s per card). Swappable with `OLLAMA_MODEL`. In tests `gemma4:e4b` was the most accurate (~4–5 s per card, "write the English meaning first" prompt); try it when optimizing. | 2026-10-09 |
| D7 | Whisper language | open — test `auto` vs `en` on a real demo clip | |
| D8 | AI-written "Right now" on Checked cards | open (Phase 3) | |
| D9 | Terms not in the glossary | open (Phase 4) | |
| D10 | Simple vs Detailed | open (Phase 4) | |
| D11 | Legal-advice or off-topic questions in Ask | open (Phase 5) | |
| D12 | Top-bar title | open (Phase 5) | |
| D13 | "Offline mode" pill | open (Phase 6) | |

Defaults unless someone objects: the speaker is shown as "Speaker"; no live "typing" lines; a repeated term links to its existing card; "Simpler" on a Checked card makes it AI-explained; Summary reads the whole transcript; a language switch affects only new items.

## Glossary format (for the teammate writing it)

File: `apps/backend/glossary/terms.json`. Every entry here shows as a **Checked** card, so only add explanations someone has checked.

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
- Start with every legal term in the two demo clips, then the common ones (objection, sustained, overruled, hearsay, witness, testimony, quorum, recess…).
