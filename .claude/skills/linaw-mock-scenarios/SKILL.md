---
name: linaw-mock-scenarios
description: Write or edit scripted hearings for the Linaw mock backend (tools/mock-server/scenarios/*.json), or extend the mock server. Use when demoing a new UI state, reproducing a bug, adding test content, or when a contract change needs mock support.
---

# Mock scenarios

`tools/mock-server` pretends to be the backend so the UI can be built and demoed with no speech-to-text or Ollama. It speaks the real contract and validates everything it loads.

## Running

```sh
pnpm dev:mock                              # UI + mock (mock restarts on file changes)
pnpm mock --speed 4                        # faster replay
pnpm mock --offline                        # "offline" status instead of "listening"
pnpm mock --scenario <name>                # scenarios/<name>.json
```

The timeline starts when the UI sends `session.start`, which happens after the user shares a tab or picks a file. Any tab with sound works, because the mock ignores the audio content.

## Scenario file shape

See `src/scenario.ts` (`ScenarioSchema`) and the existing `scenarios/impeachment-day3.json`.

```jsonc
{
  "title": "Impeachment Trial — Day 3",          // sent in status messages
  "timeline": [
    { "at": 2, "message": { /* any valid ServerMessage */ } }   // `at` = seconds after session.start
  ],
  "replies": {
    "whatSaid": ["..."],                          // what_said.result points
    "summary": { "overview": "...", "events": [{ "t": 0, "title": "...", "detail": "..." }], "openIssue": "..." },
    "answers": [{ "match": "objection", "text": "..." }],   // first case-insensitive substring match wins
    "fallbackAnswer": "..."
  },
  "simplified": { "<cardId>": { "meaning": "...", "example": "..." } }   // card.simplify rewrites
}
```

## Writing a good scenario

- **Pace it like real speech.** Use `transcript.segment` with `final: false` first and the same `id` with `final: true` a few seconds later. Then send `card.pending` about 1 second after the term is spoken, and the `card` 3–4 seconds after that. This exercises the skeleton and the dotted-to-solid underline.
- Give each term in `terms[]` the `cardId` of the card that will explain it. The pending and card messages use that same id.
- Mix `kind: "checked"` and `kind: "ai"` cards.
- Put `t: 0` in timeline messages. The server overwrites `t` with real elapsed time.
- Write content in natural, simple Tagalog. `meaning` is one sentence, `example` is an everyday comparison, and `now` says what it means at this moment of the hearing. Never give legal advice.
- To show "Earlier terms", include more than 3 cards.
- Every `simplified` key must be a card id in the timeline. Validation enforces this.

## After editing

Run `pnpm validate`, which checks every scenario against the contract, then `pnpm dev:mock` to watch it play. Commit as `feat(mock): add <name> scenario` or `fix(mock): …`.

## Extending the server

The message handling is in `MockSession.handle` in `src/server.ts`. Keep it dumb and deterministic: canned replies after `replyDelayMs`, no randomness, so demos and bug reports are reproducible. When the contract gains a client message, TypeScript's exhaustive `switch` there points at what to add.
