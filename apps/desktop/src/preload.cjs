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
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
});
