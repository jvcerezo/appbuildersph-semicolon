// @ts-check
/**
 * Linaw desktop app. One frameless window with two modes:
 *   - app:     a normal window with the library (start, past sessions)
 *   - overlay: while listening, a narrow always-on-top panel beside the video
 * It loads the web UI (apps/web), which switches the mode, and answers the
 * UI's getDisplayMedia() call with all system audio, so no share picker is
 * needed.
 *
 *   pnpm dev:overlay        UI dev server + this window (backend runs separately)
 *   electron . --prod       load apps/web/dist instead of the dev server
 */
const path = require('node:path');
const {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  session,
  shell,
} = require('electron');
const volume = require('./volume.cjs');

const DEV_URL = process.env.LINAW_URL ?? 'http://127.0.0.1:5173/';
const PROD_FILE = path.join(__dirname, '..', '..', 'web', 'dist', 'index.html');
const useBuild = process.argv.includes('--prod') || app.isPackaged;

const GHOST_SHORTCUT = 'CommandOrControl+Shift+L';
const GHOST_OPACITY = 0.55;
const RETRY_MS = 1000;

/** @type {BrowserWindow | null} */
let win = null;
let ghost = false;
/** @type {'app' | 'overlay'} */
let mode = 'app';
/** Where the user last put each mode's window, so switching back restores it. */
/** @type {Record<'app' | 'overlay', Electron.Rectangle | null>} */
const lastBounds = { app: null, overlay: null };

/** @param {'app' | 'overlay'} target */
function defaultBounds(target) {
  const { workArea } = screen.getPrimaryDisplay();
  if (target === 'overlay') {
    const width = 420;
    const height = Math.min(720, workArea.height - 48);
    // Top-right corner, where it covers the least of a typical video.
    return { x: workArea.x + workArea.width - width - 24, y: workArea.y + 24, width, height };
  }
  const width = Math.min(1180, workArea.width - 80);
  const height = Math.min(780, workArea.height - 80);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

/** @param {'app' | 'overlay'} next */
function setMode(next) {
  if (!win || next === mode) return;
  if (win.isMaximized()) win.unmaximize();
  lastBounds[mode] = win.getBounds();
  mode = next;
  if (next === 'app' && ghost) setGhost(false);
  if (next === 'overlay') {
    win.setMinimumSize(340, 320);
    // 'screen-saver' keeps the panel above full-screen video players too.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
    win.setMinimumSize(720, 520);
  }
  win.setBounds(lastBounds[next] ?? defaultBounds(next));
}

function createWindow() {
  win = new BrowserWindow({
    ...defaultBounds('app'),
    minWidth: 720,
    minHeight: 520,
    frame: false,
    backgroundColor: '#ffffff',
    title: 'Linaw',
    // Taskbar and window icon (build/icon.ico has every Windows size; PNG elsewhere).
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  lockDown(win);
  load(win);
}

/**
 * Load the UI; in dev, keep retrying until the Vite server is up.
 * @param {BrowserWindow} target
 */
function load(target) {
  if (useBuild) {
    void target.loadFile(PROD_FILE);
    return;
  }
  target.webContents.on('did-fail-load', (_event, _code, _desc, url) => {
    if (url.startsWith(new URL(DEV_URL).origin)) setTimeout(() => void target.loadURL(DEV_URL), RETRY_MS);
  });
  void target.loadURL(DEV_URL).catch(() => {
    // did-fail-load schedules the retry.
  });
}

/**
 * The overlay only ever shows Linaw: no navigation, no popups.
 * @param {BrowserWindow} target
 */
function lockDown(target) {
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  target.webContents.on('will-navigate', (event) => event.preventDefault());
}

/** @param {boolean} on */
function setGhost(on) {
  // Ghost mode only makes sense over a video, i.e. in overlay mode.
  if (on && mode !== 'overlay') return;
  ghost = on;
  if (!win) return;
  // Click-through: mouse events go to the video underneath.
  win.setIgnoreMouseEvents(on, { forward: true });
  win.setOpacity(on ? GHOST_OPACITY : 1);
  win.webContents.send('ghost:changed', on);
}

/**
 * The UI calls getDisplayMedia(); answer with the primary screen plus all
 * system audio ("loopback", Windows). The UI drops the video track.
 */
function handleDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then(([source]) => {
          if (!source) throw new Error('No screen to capture');
          callback({ video: source, audio: 'loopback' });
        })
        .catch((err) => {
          console.error('[linaw] could not capture system audio:', err);
          callback({});
        });
    },
    { useSystemPicker: false },
  );

  // Allow only what Linaw needs.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });
}

app.whenReady().then(() => {
  handleDisplayMedia();
  volume.warmUp();

  // Push to talk: lower the speakers while the user speaks (true), give the volume back (false).
  ipcMain.handle('volume:duck', (_event, on) => (on ? volume.duck() : volume.restore().then(() => true)));

  ipcMain.on('ghost:set', (_event, on) => setGhost(Boolean(on)));
  ipcMain.on('window:mode', (_event, next) => setMode(next === 'overlay' ? 'overlay' : 'app'));
  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.on('window:toggleMaximize', () => {
    if (!win || mode !== 'app') return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', () => win?.close());

  // A global shortcut is the only way back from ghost mode, since the window ignores clicks.
  globalShortcut.register(GHOST_SHORTCUT, () => setGhost(!ghost));

  createWindow();
  if (process.env.LINAW_SNAPSHOT && win) require('./snapshot.cjs').scheduleSnapshot(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Never leave the user's speakers turned down.
app.on('before-quit', (event) => {
  if (!volume.isDucked()) return;
  event.preventDefault();
  void volume.restore().finally(() => app.quit());
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  volume.stop();
});
app.on('window-all-closed', () => app.quit());
