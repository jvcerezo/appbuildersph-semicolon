# Wiring a backend into Linaw

The UI is done and waiting. Your backend only has to do one thing: **run a WebSocket server on `ws://localhost:8765` that speaks the [contract](contract.md)**. Use any language and any models.

## What you get from this repo

| Thing | Where | Use it for |
|---|---|---|
| The contract, in plain words | [`docs/contract.md`](contract.md) | Understanding the messages and the session flow |
| **JSON Schema** of every message | [`packages/contract/schema/linaw-contract.schema.json`](../packages/contract/schema/linaw-contract.schema.json) | Validating messages, or generating types in your language |
| Example of every message | [`packages/contract/examples/`](../packages/contract/examples) | Copy-paste fixtures and unit tests |
| **Conformance checker** | `pnpm conformance` | Proving your backend works before you open the UI |

## Steps

### 1. Put your code in `backend/`

Any language works. `backend/` sits outside the pnpm workspace, so Python, Go, Rust or anything else is fine. Add your own README there with how to install and run it.

### 2. Generate types from the schema (optional, recommended)

The schema has `$defs/ServerMessage` (what you send) and `$defs/ClientMessage` (what you receive):

```sh
# Python / Pydantic v2
pip install datamodel-code-generator
datamodel-codegen --input packages/contract/schema/linaw-contract.schema.json \
  --input-file-type jsonschema --output-model-type pydantic_v2.BaseModel --output backend/contract.py

# Go, Rust, C#, Kotlin, Swift, … (quicktype)
npx quicktype -s schema packages/contract/schema/linaw-contract.schema.json -o backend/contract.go
```

Regenerate whenever the schema changes. Its `x-contract-version` field tells you which version you have.

### 3. Implement the server

The minimum loop:

1. **On connect**, send `status` (`waiting`) with an optional session `title`.
2. **On `session.start`**, reply with `status: listening`. Then **append each binary frame to one byte stream**: the frames form a single continuous WebM/Opus file, and only the first frame has the header. The easiest way to decode it is to pipe that stream into `ffmpeg -i pipe:0 -f s16le -ac 1 -ar 16000 pipe:1` and feed the PCM output to your speech-to-text.
3. **As speech is recognized**, send `transcript.segment`:
   - Resend the same `id` with `final: false` while a line is in progress, then once more with `final: true`.
   - Flag jargon in `terms[]`, giving each one the `cardId` you plan to use.
4. **For each flagged term**:
   - Send `card.pending` (with that id) right away.
   - Then send the `card` once your model has written it: `meaning`, `example`, `now`, `kind: "checked"` if it came from a vetted glossary or `"ai"` if a model wrote it, and `language` from the user's preferences.
5. **Answer requests** with the same `requestId`:

   | Request | Reply with |
   |---|---|
   | `what_said.request` | `what_said.result` |
   | `summary.request` | `summary.result` |
   | `ask` | `answer` |
   | `card.simplify` | `card` with the same id |

   If something fails, reply with `error` and the `requestId`.
6. **On `session.stop`**, reply with `status: stopped`.
7. **On `preferences.update`**, use the new `level` and `language` for anything you write from then on.

Rules the UI depends on:

- Bind to `127.0.0.1` only. Linaw makes no network calls beyond localhost, and the backend should not either. Ollama on localhost is fine.
- Send **only JSON text frames**, and never add fields that aren't in the schema (it uses `additionalProperties: false`).
- `t` is seconds since `session.start`.
- If you run without internet (which should be always, since everything is local), you may send `status: offline`. The UI shows "Offline mode — still working".
- Content must be short, plain Tagalog (or English if `language` is `en`). Linaw explains terms. **It never gives legal advice.**

### 4. Check it with the conformance tool

With your backend running:

```sh
pnpm install          # once
pnpm conformance                               # protocol checks, no audio
pnpm conformance --audio sample.webm --fast    # also stream a recording through your STT
```

You get a checklist of passes, failures and warnings, each with what went wrong. The command exits with code 1 on any failure, so you can run it in CI too. Flags: `--url`, `--timeout <s>`, `--mime`.

To make a test recording, record any hearing clip as WebM/Opus. For example: `ffmpeg -i clip.mp4 -vn -c:a libopus sample.webm`.

### 5. Run it with the real UI

```sh
pnpm dev:overlay   # overlay window (Windows: captures system audio)
pnpm dev           # or the browser version at http://localhost:5173
```

Start your backend first, or after. The UI shows "Can't reach Linaw's helper" and keeps retrying until it connects. To use another port, set `VITE_BACKEND_URL=ws://localhost:9000` when running the UI.

## When the contract needs to change

Don't edit the schema JSON by hand. Change `packages/contract/src/index.ts` and run `pnpm --filter @linaw/contract schema`, then update the examples and `docs/contract.md`. The `linaw-contract` skill has the full checklist. Agree on the change with the UI side first, because both halves move together.
