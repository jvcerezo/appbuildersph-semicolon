---
name: linaw-backend
description: Build, wire in, or debug the Linaw backend (speech-to-text + Ollama) in backend/ against the UI contract, in any language. Use when implementing backend message handling, audio decoding, generating types from the JSON Schema, or when `pnpm conformance` fails.
---

# Linaw backend

The UI is finished and talks only to `ws://localhost:8765` using the contract. The backend lives in `backend/`, in any language. **Read `docs/backend.md` first.** It has the message loop, the audio format, and type generation for Python and other languages.

## Source of truth

- Messages: `packages/contract/src/index.ts` (zod), exported as `packages/contract/schema/linaw-contract.schema.json`. Validate what you send against `$defs/ServerMessage`.
- Fixtures: `packages/contract/examples/{server,client}/*.json`.
- Never hand-edit the schema JSON, and never send fields the schema lacks (`additionalProperties: false`). If you need something new, follow the `linaw-contract` skill and coordinate with the UI.

## Working loop

1. Start the backend.
2. Run `pnpm conformance` until it's all ✓, then `pnpm conformance --audio <clip.webm> --fast` to exercise speech-to-text and cards end to end.
3. Run `pnpm dev:overlay` (Windows, system audio) or `pnpm dev` (browser) and watch the real UI.

## Common failures (what `pnpm conformance` reports)

| Report | Usual cause |
|---|---|
| ✗ Sends `status` as soon as the UI connects | Waiting for `session.start` before saying anything. Send `status: waiting` on connect. |
| ✗ Turns audio into `transcript.segment` | Each binary frame decoded on its own. They form **one** WebM stream (header only in the first frame), so append them and decode the stream, e.g. through `ffmpeg -i pipe:0`. |
| ✗ Every message matches the contract | Wrong enum value, missing required field, extra field, or `t` sent as a string. The report shows the exact path and the message. |
| ✗ Answers `ask` → `answer` | Reply is missing `requestId`, or a model error was swallowed. Send `error` with the `requestId` instead. |
| ! Every `card.pending` is followed by a `card` | The model call failed after `card.pending` was sent. Retry, or send an `error`. Don't leave the skeleton hanging. |
| ! Answers an invalid message with `error: bad_request` | Optional, but it makes UI bugs much easier to find. |

## Content rules

`meaning`, `example`, `now`, summaries and answers are user-facing. Write them in short, plain Tagalog (or English when `preferences.language` is `en`), honor `level` (`simple` or `detailed`), mark model-written cards `kind: "ai"`, and **never give legal advice**.

## Constraints

- Bind to `127.0.0.1`. Make no cloud calls; Ollama and models run locally.
- `t` is seconds since `session.start`.
- Reconnects: the UI resends `session.start` followed by a fresh WebM stream. Treat it as a new stream on that connection.
