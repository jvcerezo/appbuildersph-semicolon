---
name: linaw-overlay
description: Work on Linaw's desktop overlay — the Electron shell in apps/desktop (always-on-top window, system audio capture, ghost mode, IPC bridge) and the compact layout in apps/web/src/overlay. Use when changing window behavior, adding a shell feature, debugging audio capture, or verifying the overlay visually with screenshots.
---

# Linaw desktop overlay

## How it works

- `apps/desktop/src/main.cjs` opens a **frameless, always-on-top** window (level `screen-saver`, so it stays above full-screen video). The window is 420 px wide and sits in the top-right corner. It loads:
  - dev: `http://127.0.0.1:5173/?overlay`, retrying until Vite is up (override with `LINAW_URL`)
  - `--prod`: `apps/web/dist/index.html?overlay` (Vite builds with `base: './'` for this)
- **Audio**: the UI calls `getDisplayMedia()` as it would in a browser. `setDisplayMediaRequestHandler` answers with the primary screen plus `audio: 'loopback'`, which is all system audio, with no picker. The UI drops the video track. Loopback works on **Windows** only; elsewhere the UI shows `NoAudioError`.
- **Ghost mode**: `setIgnoreMouseEvents(true, { forward: true })` plus `setOpacity(0.55)`. Because the window then ignores clicks, the **global shortcut Ctrl+Shift+L** is the only way back. Never remove it.
- **Bridge**: `preload.cjs` exposes `window.linawDesktop` (`setGhost`, `onGhostChange`, `minimize`, `close`, `platform`). Its type lives in `apps/web/src/lib/desktop.ts`. Keep those two files in sync, and keep the API small. Never expose `ipcRenderer`, Node or the file system to the page.
- **Lockdown**: `contextIsolation`, `sandbox`, no `nodeIntegration`, navigation blocked, popups denied, and only `media` and `display-capture` permissions allowed. The no-network rule applies here too.

## Adding a shell feature

1. Add an IPC channel in `main.cjs` (`ipcMain.on('area:verb', …)`), validating and coercing every argument.
2. Expose a narrow function in `preload.cjs`.
3. Add it to the `LinawDesktop` interface in `lib/desktop.ts`.
4. In the UI, guard with `desktop?.` so the browser version keeps working.

## Running

```sh
pnpm dev:overlay                 # Vite + overlay window (start the backend separately)
pnpm --filter @linaw/desktop start   # load the production build (run `pnpm build` first)
```

If `electron` fails with "Electron failed to install correctly", its binary download was skipped. Run `node node_modules/.pnpm/electron@*/node_modules/electron/install.js`.

## Verifying visually (do this after UI changes)

`snapshot.cjs` saves a PNG of the overlay and quits. Run it with Vite (`pnpm dev`) running. To see cards and captions, a backend must be running on :8765 too; without one you get the start screen with the "Can’t reach Linaw’s helper" banner:

```sh
cd apps/desktop
LINAW_SNAPSHOT=/tmp/ov.png LINAW_SNAPSHOT_DELAY=2500 npx electron .
# Drive it: click buttons by their text, separated by >>
LINAW_SNAPSHOT=/tmp/ov.png LINAW_SNAPSHOT_CLICK="Start listening>>Summary" LINAW_SNAPSHOT_STEP=2000 npx electron .
# Mid-session: wait long enough for the backend to send a few cards
LINAW_SNAPSHOT=/tmp/ov.png LINAW_SNAPSHOT_CLICK="Start listening" LINAW_SNAPSHOT_DELAY=36000 npx electron .
```

Then open the PNG and check: nothing clipped at 420 px, the newest card visible at the top, and the high-contrast theme still readable. To run two snapshots in parallel, give the second one its own `--user-data-dir`.

## Gotchas

- `transparent: true` windows can't be resized on Windows, so the window is opaque and ghost mode uses `setOpacity`.
- Loopback also captures Linaw's own read-aloud. That's fine for now, but keep it in mind if the backend ever hears its own voice.
- The title bar is `-webkit-app-region: drag`. Every interactive element inside it needs `no-drag` (the `.ov-bar button` rule handles buttons).
