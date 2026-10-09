// @ts-check
/**
 * Linaw desktop overlay: a small frameless window that stays on top of the
 * video the user is watching. It loads the web UI (apps/web) and answers the
 * UI's getDisplayMedia() call with all system audio, so no share picker is
 * needed.
 *
 *   pnpm dev:overlay        UI dev server + mock backend + this window
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

const DEV_URL = process.env.LINAW_URL ?? 'http://127.0.0.1:5173/?overlay';
const PROD_FILE = path.join(__dirname, '..', '..', 'web', 'dist', 'index.html');
const useBuild = process.argv.includes('--prod') || app.isPackaged;

const GHOST_SHORTCUT = 'CommandOrControl+Shift+L';
const GHOST_OPACITY = 0.55;
const RETRY_MS = 1000;

/** @type {BrowserWindow | null} */
let win = null;
let ghost = false;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 420;
  const height = Math.min(720, workArea.height - 48);

  win = new BrowserWindow({
    width,
    height,
    minWidth: 340,
    minHeight: 320,
    // Top-right corner, where it covers the least of a typical video.
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#ffffff',
    title: 'Linaw',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // 'screen-saver' keeps the panel above full-screen video players too.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
    void target.loadFile(PROD_FILE, { query: { overlay: '1' } });
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

  ipcMain.on('ghost:set', (_event, on) => setGhost(Boolean(on)));
  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.on('window:close', () => win?.close());

  // A global shortcut is the only way back from ghost mode, since the window ignores clicks.
  globalShortcut.register(GHOST_SHORTCUT, () => setGhost(!ghost));

  createWindow();
  if (process.env.LINAW_SNAPSHOT && win) require('./snapshot.cjs').scheduleSnapshot(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
