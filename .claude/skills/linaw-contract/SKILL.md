---
name: linaw-contract
description: How to add or change a message in the Linaw UI↔backend WebSocket contract (packages/contract). Use whenever a feature needs data the UI doesn't get yet, a new request or reply, a new field, or when touching socket.ts, session.ts message handling, examples, or docs/contract.md.
---

# Changing the Linaw contract

The contract in `packages/contract/src/index.ts` is the only agreement between the UI and the teammate-owned backend. Both sides code against it, so a careless change breaks the other person's work without warning.

## Before you change anything

1. **Check you need to.** Can the UI derive this from messages it already gets? For example, card counts, or which transcript terms are explained. If so, derive it in `apps/web/src/state/session.ts` and leave the contract alone.
2. **Additive or breaking?**
   - *Additive*: a new message type, or a new **optional** field. Safe; keep `CONTRACT_VERSION`.
   - *Breaking*: removing or renaming a field or type, making a field required, or narrowing an enum. Bump `CONTRACT_VERSION`, and say so loudly in the commit and to the backend owner.

## Steps

1. **Schema** — edit `packages/contract/src/index.ts`.
   - Every message object has `v` and a literal `type`, and is added to `ServerMessageSchema` or `ClientMessageSchema`.
   - Type names are `noun.verb` or `noun.result` in snake_case (`card.pending`, `what_said.request`).
   - Correlate a request with its reply through `requestId`.
   - Times are `t` in seconds since session start.
   - Add a JSDoc comment to any field whose meaning isn't obvious.
2. **Example** — add or update `packages/contract/examples/{server|client}/<type>.json`. The filename must equal the `type`. Use realistic Tagalog content, not "lorem". `pnpm validate` fails if any type lacks an example.
3. **Mock** — make `tools/mock-server/src/server.ts` send or handle the new message. If it carries content, add it to the scenario format in `tools/mock-server/src/scenario.ts` and to `scenarios/*.json` (see the `linaw-mock-scenarios` skill).
4. **UI** — handle it in `apps/web/src/state/session.ts` (`applyServerMessage`). TypeScript's exhaustive `switch` shows you where. Send client messages only through `BackendSocket.send` in `lib/socket.ts`.
5. **Docs** — update the tables in `docs/contract.md`.
6. **Verify** — run `pnpm check`. For behavior, run `pnpm dev:mock` and exercise the feature.
7. **Commit** as `feat(contract): …`, or `feat(contract)!: …` with a `BREAKING CHANGE:` footer. Keep contract changes in their own commit, separate from the UI work that uses them.

## Rules

- Never parse socket JSON outside `lib/socket.ts`, and never cast unvalidated data to a contract type.
- Never add fields "just in case". Each field must have a consumer.
- Content strings (`meaning`, `example`, `now`, answers) are for the user. They are in `preferences.language`, plain and short, and never legal advice.
- Audio stays binary frames, not JSON. Don't base64 audio into messages.
