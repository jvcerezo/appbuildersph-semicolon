---
name: linaw-demo
description: Run, extend or write scenarios for Linaw's scripted demo backend (tools/demo-backend) — used for demos, pitches and UI work before the real backend is ready. Use when preparing a demo, adding demo content (transcript lines, translations, cards, summaries with sources, answers), or when the UI needs data the real backend can't send yet.
---

# Linaw demo backend

`tools/demo-backend` plays a scripted hearing over the **real** contract and socket. It's what `pnpm dev:demo` runs. It passes `pnpm conformance`, so the backend team can also read it as a small reference implementation. It is **not** the product backend: it ignores the audio it receives.

## Running

```sh
pnpm dev:demo                     # overlay + UI + demo backend (watch mode)
pnpm demo --speed 3               # demo backend only, 3x faster (pair with pnpm dev:overlay or pnpm dev)
pnpm demo --offline               # show the "Offline — still working" state
pnpm demo --scenario <name>       # scenarios/<name>.json
```

The script starts when the UI sends `session.start`, that is, when the user clicks **Start listening**. Every new session restarts it.

## How replies stay realistic

Replies are built from **what has been said so far** (`said` = final segments already sent):

- `whatSaid`: the last stage whose `after` segment was said. Its `sources` are filtered to said segments.
- `summary.overviews`: the last stage whose `after` was said. `events` are included once **all** their sources were said, and each event's `t` is the time of its first source. `openIssues` show from `after` until `until`.
- `answers`: the first entry whose `match` keywords appear in the question **and** that has a said source. Otherwise `fallbackAnswer`.
- `simplified`: `card.simplify` rewrites, by card id.
- Transcript `translation`s are sent only when their language matches the user's language setting (the demo hearing is in English with Tagalog translations).

## Writing a scenario

Scenarios are JSON validated by `ScenarioSchema` in `src/scenario.ts`, and `pnpm validate` also cross-checks every id. Tips:

- Write the timeline in order: a partial segment (`final: false`, same `id`) a few seconds before the final one, then `card.pending` about 1 s after the term, and the `card` about 3 s later.
- Give each term in `terms[]` the `cardId` of its card. Put the Tagalog line in `translation`.
- Cite **segment ids** in sources. Prefer 1–3 lines that actually support the claim, because the UI quotes them.
- Write Tagalog that is natural and simple. Cards explain terms and never give legal advice.
- Keep a run to about 2–3 minutes at speed 1, so a live demo doesn't drag.
- `senate-trial.json` was generated from a compact script. Editing the JSON directly is fine.

## Verifying

Run `pnpm validate`, then `pnpm conformance` with the demo running (it should be all ✓). Then check it visually with the screenshot steps in the `linaw-overlay` skill.
