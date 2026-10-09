# Linaw

**Understand what's being said.** Linaw sits next to a hearing or trial you're watching and explains the hard words in simple Tagalog, as they are said.

- **A floating overlay.** A small window stays on top of YouTube, Facebook, a news site or a video call, and listens to what's playing on your computer.
- **A card for each legal term**, with its meaning, an everyday example, and what it means right now in the hearing.
- **Translations.** Lines spoken in English get a Tagalog translation underneath.
- **Help on demand.** Ask "What did they say?", get a summary, or ask your own question. Each answer cites the transcript lines it is based on.
- **Ghost mode** makes the overlay see-through and click-through, so it never blocks the video.
- **Large text, a high-contrast theme and read-aloud.**
- **Everything runs on your computer.** Linaw makes no cloud calls.

> Linaw explains terms. It is not legal advice.

## Quick start

You need Node 20+ and pnpm (`npm i -g pnpm`).

### See the demo

```sh
pnpm install
pnpm dev:demo
```

The overlay opens with a **scripted demo backend** behind it. Click **Start listening** to play a 2½-minute Senate impeachment hearing in English. You'll see:

- Live captions with **Tagalog translations**, and the full transcript in the **Transcript** tab.
- Jargon cards as legal terms come up.
- **Summary**, **What did they say?** and **Ask a question**, each citing the transcript lines it is based on. Tap a source to jump to it.

For a faster run, start the demo backend at 3x speed (`pnpm demo --speed 3`) and run `pnpm dev:overlay` alongside it.

### With the real backend

```sh
pnpm dev:overlay
```

The Linaw overlay opens in the top-right corner of your screen. Start the backend (see [`backend/`](backend/README.md)), play the hearing, and click **Start listening**. Until the backend is running, the overlay shows “Can’t reach Linaw’s helper” and keeps retrying.

| Shortcut | Does |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> | Toggle ghost mode (see-through and click-through) |

Capturing system audio works on **Windows**. On other systems, use the browser version below.

### Browser version

```sh
pnpm dev
```

Open http://localhost:5173 in **Chrome or Edge** for the full-window layout, or http://localhost:5173/?overlay for the compact one. Choose **Listen to a browser tab**, pick the tab with the hearing, and turn on **Share tab audio**.

## Building the backend

The backend (speech-to-text + Ollama) can be written in any language. It only has to serve the contract on `ws://localhost:8765`. Start with **[docs/backend.md](docs/backend.md)**, then check your server with:

```sh
pnpm conformance                              # protocol checks
pnpm conformance --audio sample.webm --fast   # also stream a recording
```

## How it fits together

```
 system audio / tab / file
            │
            ▼
 apps/desktop (Electron overlay) ─ loads ─▶ apps/web (React UI) ◀── WebSocket :8765 ──▶ backend (speech-to-text + Ollama)
                                                  │                                     └ backend/ (any language)
                                                  └── speaks only packages/contract
```

| Path | What |
|---|---|
| `apps/web` | The UI (Vite + React + TypeScript): full layout and compact overlay layout |
| `apps/desktop` | Electron shell: always-on-top window, system audio, ghost mode |
| `packages/contract` | Message schemas (zod), types and example payloads |
| `packages/contract/schema` | Generated JSON Schema, for backends in any language |
| `tools/conformance` | Checks a running backend against the contract |
| `tools/demo-backend` | Scripted demo backend, also a reference implementation |
| `backend/` | The backend team’s code |
| `docs/backend.md` | How to wire a backend in |
| `docs/contract.md` | The contract in plain words |

## Scripts

| Command | Does |
|---|---|
| `pnpm dev:demo` | Overlay window, UI and the scripted demo backend |
| `pnpm dev:overlay` | Overlay window and UI (real backend runs separately) |
| `pnpm demo` | Demo backend only (`--speed 3`, `--offline`) |
| `pnpm dev` | UI in the browser |
| `pnpm conformance` | Check a running backend against the contract |
| `pnpm typecheck` | Type-check every package |
| `pnpm validate` | Check examples against the contract and that the JSON Schema is current |
| `pnpm build` | Production build of the UI |
| `pnpm check` | Typecheck, validate and build (what CI runs) |

Set `VITE_BACKEND_URL` to point the UI at a backend on a different port.

## Working with coding agents

`CLAUDE.md` holds the project rules, and `.claude/skills/` has guides for the contract, the UI design system, the overlay shell, the backend, the demo and commit messages.
