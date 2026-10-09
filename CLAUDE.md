# Linaw — guide for Claude Code

Linaw is an **overlay that floats over the hearing a user is watching** and explains legal jargon in simple Tagalog as it is said. Two halves meet at one WebSocket:

- **UI** (`apps/web`) — this repo's main work. Vite + React + TypeScript with two layouts over one hook (`state/useLinaw.ts`):
  - **Overlay** (`src/overlay/`) — the primary product: a narrow, always-on-top panel. Used in the desktop shell, or in a browser at `?overlay`.
  - **Full window** (`screens/`) — the original design's layout, for a normal browser tab.
- **Desktop shell** (`apps/desktop`) — Electron. A frameless always-on-top window that loads the UI, captures system audio (Windows loopback, no picker), and has ghost mode (see-through + click-through, Ctrl+Shift+L).
- **Backend** — owned by a teammate (speech-to-text + Ollama, all local). Not in this repo yet. Until it exists, `tools/mock-server` plays its part.
- **Contract** (`packages/contract`) — zod schemas for every message between them. The single source of truth.

## Hard rules

1. **The UI only speaks the contract.** All backend traffic goes through `apps/web/src/lib/socket.ts`, which validates every incoming message with `parseServerMessage`. Never `JSON.parse` socket data anywhere else, never invent fields, never send a message that isn't in `ClientMessageSchema`. Need something new? Change the contract first (use the `linaw-contract` skill).
2. **No network beyond localhost.** No CDNs, analytics, remote fonts, cloud APIs or cloud TTS voices. Fonts and icons are bundled npm packages. Read-aloud uses on-device voices only (`localService`). The only socket is `ws://localhost:8765`.
3. **Not legal advice.** Copy explains terms; it never tells the user what to do legally.
4. **Accessibility is the product.** Users may be older, low-vision or new to legal language. Follow the `linaw-ui` skill: big type, ≥44px targets, high-contrast theme, plain-English chrome, Tagalog content marked `lang="tl"`.

## Commands

```sh
pnpm install
pnpm dev:overlay  # overlay window + UI + mock backend (most common)
pnpm dev:mock     # UI + mock backend in the browser
pnpm dev          # UI only
pnpm mock         # mock backend only; add flags after: pnpm mock --speed 4 --offline
pnpm typecheck    # all packages
pnpm validate     # contract examples + mock scenarios against the schemas
pnpm build        # production build of the UI
pnpm check        # typecheck + validate + build (what CI runs)
```

Run `pnpm check` before committing.

## Layout

```
apps/web/src/
  App.tsx              picks the overlay or full-window layout
  state/useLinaw.ts    all behavior: socket, audio capture, settings, actions
  overlay/             OverlayApp + overlay.css (compact layout)
  lib/desktop.ts       typed bridge to the Electron shell (window.linawDesktop)
  lib/socket.ts        the only backend connection (validates with the contract)
  lib/audio.ts         tab/system capture (getDisplayMedia), file capture, MediaRecorder chunks
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
tools/mock-server/
  src/server.ts        mock backend
  scenarios/*.json     scripted hearings
docs/contract.md       human-readable contract for the backend teammate
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
- `linaw-mock-scenarios` — writing scripted hearings for the mock
- `commit-conventions` — commit message format
