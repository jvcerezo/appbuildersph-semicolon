// @ts-check
/** Exposes the small, fixed API the UI needs as `window.linawDesktop` (see apps/web/src/lib/desktop.ts). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linawDesktop', {
  platform: process.platform,
  /** @param {boolean} on */
  setGhost: (on) => ipcRenderer.send('ghost:set', Boolean(on)),
  /** @param {(on: boolean) => void} listener */
  onGhostChange: (listener) => {
    /** @param {unknown} _event @param {boolean} on */
    const handler = (_event, on) => listener(on);
    ipcRenderer.on('ghost:changed', handler);
    return () => ipcRenderer.removeListener('ghost:changed', handler);
  },
  /** @param {'app' | 'overlay'} mode */
  setMode: (mode) => ipcRenderer.send('window:mode', mode),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
  close: () => ipcRenderer.send('window:close'),
  /**
   * Push to talk: lower the speakers while the user speaks (true), then restore them (false).
   * Resolves to false when this computer's volume can't be changed.
   * @param {boolean} on @returns {Promise<boolean>}
   */
  duckVolume: (on) => ipcRenderer.invoke('volume:duck', Boolean(on)),
});
