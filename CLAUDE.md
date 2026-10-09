# Linaw — guide for Claude Code

Linaw is a **standalone desktop app**. When idle it is a library of past sessions (summary, transcript, terms). While listening it becomes an **overlay that floats over the hearing** and explains legal jargon in simple Tagalog as it is said. Two halves meet at one WebSocket:

- **UI** (`apps/web`) — this repo's main work. Vite + React + TypeScript; all behavior lives in one hook (`state/useLinaw.ts`):
  - **Library** (`src/library/`) — the app when nothing is live: start a session and browse past sessions. Sessions are stored locally in IndexedDB (`lib/history.ts`) and never sent anywhere.
  - **Overlay** (`src/overlay/`) — the live layout: a narrow, always-on-top panel. Used in the desktop shell, or in a browser at `?overlay`.
  - **Full window** (`screens/LiveScreen`) — the original design's live layout, for a normal browser tab.
- **Desktop shell** (`apps/desktop`) — Electron. One frameless window with two modes the UI switches: `app` (normal window, library) and `overlay` (always on top while listening). Captures system audio (Windows loopback, no picker) and has ghost mode (see-through + click-through, Ctrl+Shift+L) in overlay mode.
- **Backend** (`backend/`) — TypeScript. Serves the contract: decodes the UI's audio (ffmpeg), streams it to the speech service, finds glossary terms and writes cards with Ollama. Integration guide: `docs/backend.md`. `pnpm conformance` checks any running backend against the contract.
- **Speech service** (`stt/`) — Python (uv). Turns audio into text: Soniox when online, local Whisper (WhisperLiveKit) when offline, switching mid-session without losing words. The backend talks to it on `ws://127.0.0.1:8000/ws/stream`. Guide: `stt/README.md`.
- **Contract** (`packages/contract`) — zod schemas for every message between them. The single source of truth. A generated JSON Schema (`schema/`) serves non-TypeScript backends.

## Hard rules

1. **The UI only speaks the contract.** All backend traffic goes through `apps/web/src/lib/socket.ts`, which validates every incoming message with `parseServerMessage`. Never `JSON.parse` socket data anywhere else, never invent fields, never send a message that isn't in `ClientMessageSchema`. Need something new? Change the contract first (use the `linaw-contract` skill).
2. **No network beyond localhost, except Soniox in `stt/`.** The UI makes no outside calls: no CDNs, analytics, remote fonts, cloud APIs or cloud TTS voices. Fonts and icons are bundled npm packages. Read-aloud uses on-device voices only (`localService`). The UI's only socket is `ws://localhost:8765`. The one cloud call in the project is the speech service streaming to Soniox; its API key lives only in `stt/.env` and never reaches the UI or the backend. Everything must keep working offline (local Whisper), and `STT_MODE=local_only` turns the cloud off entirely.
3. **Not legal advice.** Copy explains terms; it never tells the user what to do legally.
4. **Accessibility is the product.** Users may be older, low-vision or new to legal language. Follow the `linaw-ui` skill: big type, ≥44px targets, high-contrast theme, plain-English chrome, Tagalog content marked `lang="tl"`.

## Commands

```sh
pnpm install
pnpm dev:demo     # overlay window + UI + scripted demo backend (for demos and UI work)
pnpm dev:overlay  # overlay window + UI (start the backend separately)
pnpm demo         # demo backend only: --speed 3, --offline
pnpm dev          # UI only, in the browser
pnpm conformance  # check a running backend: add --audio clip.webm --fast to test speech too
pnpm stt         # the speech service (first time: pnpm stt:setup, and SONIOX_API_KEY in stt/.env)
pnpm backend      # the real backend (needs the speech service, ffmpeg and Ollama, see backend/README.md)
pnpm dev:overlay:backend  # overlay window + UI + speech service + real backend
pnpm typecheck    # all packages
pnpm validate     # contract examples, JSON Schema up to date, backend glossary
pnpm build        # production build of the UI
pnpm check        # typecheck + validate + build (what CI runs)
```

Run `pnpm check` before committing.

## Layout

```
apps/web/src/
  App.tsx              library when idle; overlay or full-window layout while live
  state/useLinaw.ts    all behavior: socket, audio capture, settings, actions
  library/             LibraryApp + library.css (sidebar, home, session pages)
  lib/history.ts       past sessions in IndexedDB
  overlay/             OverlayApp + overlay.css (compact layout)
  lib/desktop.ts       typed bridge to the Electron shell (window.linawDesktop)
  lib/socket.ts        the only backend connection (validates with the contract)
  lib/audio.ts         tab/system capture (getDisplayMedia), MediaRecorder chunks
  lib/settings.ts      user settings + localStorage
  lib/speech.ts        read-aloud with on-device voices
  state/session.ts     reducer: server messages -> UI state
  screens/             StartScreen (+ ShareHelper), LiveScreen
  components/          TopBar, JargonCard, TranscriptPanel, ActionBar, HelpPanel, SettingsDialog
  styles.css           design tokens (light + high contrast) and all styles
apps/desktop/src/
  main.cjs             window, system-audio handler, ghost mode, lockdown
  preload.cjs          exposes window.linawDesktop
  snapshot.cjs         dev aid: screenshot the overlay (see linaw-overlay skill)
packages/contract/
  src/index.ts         schemas, types, parse helpers
  examples/            one JSON example per message type (validated)
  schema/              generated JSON Schema (pnpm --filter @linaw/contract schema)
tools/conformance/     backend conformance checker
tools/demo-backend/    scripted demo backend (passes conformance; reference for the backend team)
backend/               the real backend (TypeScript): contract, audio decoding, glossary, cards
stt/                   speech service (Python): Soniox online, local Whisper offline, /ws/stream
docs/contract.md       human-readable contract
docs/backend.md        how to wire a backend in
```

## Conventions

- TypeScript strict; no `any`, no non-null `!` where a type can say it instead.
- Plain CSS with the tokens in `styles.css`; sizes in `rem` so the text-size setting scales everything.
- Server state lives in `state/session.ts`; components stay presentational.
- Commits follow the `commit-conventions` skill. Never add AI attribution or `Co-Authored-By` trailers.

## Skills in `.claude/skills/`

- `linaw-contract` — changing or adding messages
- `linaw-ui` — design system, accessibility and states
- `linaw-overlay` — the Electron shell, overlay layout, ghost mode, and screenshot checks
- `linaw-backend` — building or debugging the backend against the contract
- `linaw-demo` — the scripted demo backend and writing demo scenarios
- `commit-conventions` — commit message format
