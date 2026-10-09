# Linaw contract v1

How the UI and the local backend talk. The zod schemas in [`packages/contract/src/index.ts`](../packages/contract/src/index.ts) are the source of truth. This page explains them, and [`packages/contract/examples/`](../packages/contract/examples) has a valid JSON example of every message. Backends in other languages can use the generated [JSON Schema](../packages/contract/schema/linaw-contract.schema.json). To build one, start with [backend.md](backend.md).

## Connection

- The backend listens on **`ws://localhost:8765`**, bound to `127.0.0.1` only.
- **Text frames** carry JSON messages. Every message has `"v": 1` and a `"type"`.
- **Binary frames** (UI → backend only) carry audio, sent after `session.start`:
  - The encoding is the `mimeType` from `session.start`, normally `audio/webm;codecs=opus`.
  - Chunks arrive about once a second from a `MediaRecorder`. Together they form **one continuous WebM stream**, and only the first chunk has the header, so append them in order before decoding. Don't decode each chunk on its own.
- Times (`t`) are **seconds since the session started**.
- If the socket drops, the UI reconnects and sends `session.start` again, followed by a fresh WebM stream.
- Either side must ignore a message that fails validation. The backend may answer one with `error` / `bad_request`.

## Session flow

```
UI                                    Backend
 |  -- connect -->                      |
 |  <-- status: waiting --------------- |
 |  -- session.start ----------------> |
 |  -- [binary audio] ...  ----------> |
 |  <-- status: listening ------------ |
 |  <-- transcript.segment (final:false)|   partial, same id re-sent
 |  <-- transcript.segment (final:true) |   terms[] flag the jargon
 |  <-- card.pending ----------------- |   shows a skeleton card
 |  <-- card (or card.failed) -------- |   same id replaces it (or drops it)
 |  -- what_said.request / summary.request / ask / card.simplify -->
 |  <-- what_said.result / summary.result / answer / card (with requestId)
 |  -- session.stop ----------------> |
 |  <-- status: stopped -------------- |
 |  -- summary.request --------------> |   final summary, saved with the session
 |  <-- summary.result --------------- |
```

## Backend → UI

| type | when | key fields |
|---|---|---|
| `status` | On connect, and whenever the state changes | `status`: `waiting` \| `listening` \| `stopped` \| `offline`; optional `title` |
| `transcript.segment` | Speech recognized | `id`, `t`, `speaker`, `text`, `terms[]` (`text`, optional `cardId`), `final`, optional `translation` {`language`, `text`} |
| `card.pending` | A term was spotted and an explanation is coming | `id` (the future card id), `term`, `t` |
| `card` | An explanation is ready, or a simpler rewrite | `card` {`id`, `term`, `kind`: `checked` \| `ai`, `meaning`, `example`, `now`, `t`, `language`}; optional `requestId` |
| `card.failed` | The explanation promised by a `card.pending` won't come | `id` (the pending card's id) |
| `what_said.result` | Reply to `what_said.request` | `requestId`, `windowSec`, `points[]`, optional `sources[]` |
| `summary.result` | Reply to `summary.request` | `requestId`, `overview`, `events[]` {`t`, `title`, `detail`, optional `sources[]`}, optional `openIssue` |
| `answer` | Reply to `ask` | `requestId`, `question`, `text`, optional `sources[]` |
| `error` | Something failed | `code`: `bad_request` \| `unsupported_audio` \| `model_unavailable` \| `internal`; `message`; optional `requestId` |

Notes:
- `status: offline` means "working without internet". Everything is local, so the session continues normally.
- `kind: checked` means the explanation came from a verified glossary. `kind: ai` means the model wrote it, and the UI labels it "AI-explained".
- A `terms[].cardId` links the transcript to a card. The UI underlines the term with a dotted line until that card arrives, then with a solid line it can click. After `card.failed`, the UI drops the pending card and that term's underline.
- A segment with `final: true` may be sent again with the same `id` to add `terms[]` found later (for example by the model); the UI replaces it in place.
- **Translation**: when a line is spoken in a language other than `preferences.language` (for example English testimony for a Tagalog user), set `translation` to that line in the user's language. The UI shows it under the original.
- **Sources** are `transcript.segment` ids that back a summary event, a "What did they say?" result or an answer. The UI quotes those lines and lets the user jump to them, so cite only segments you have already sent.
- `meaning`, `example` and `now` should be in the language the user chose in `preferences.language`. Keep them short and plain. Linaw explains terms and never gives legal advice.

## UI → backend

| type | when | key fields |
|---|---|---|
| `session.start` | The user starts listening | `source`: `tab` \| `file` \| `system` (all computer audio, from the desktop overlay), `mimeType`, `preferences` {`level`: `simple` \| `detailed`, `language`: `tl` \| `en`} |
| `session.stop` | Sharing stopped, or the file ended | – |
| `preferences.update` | The user changed the level or language | `preferences` |
| `what_said.request` | "What did they say?" button | `requestId`, `windowSec` (120) |
| `summary.request` | "Summary" button, and once more right after `session.stop` when the user finishes a session | `requestId` |
| `ask` | The user asked a question | `requestId`, `question` (≤ 500 chars, Tagalog or English) |
| `card.simplify` | "Simpler" on a card | `requestId`, `cardId`; reply with `card` using the same id and the `requestId` |

## Changing the contract

Follow the `linaw-contract` skill: edit the schema, regenerate the JSON Schema, update the examples, run `pnpm check`, and tell the backend owner. For a breaking change, bump `CONTRACT_VERSION`.
