/**
 * Bridge to the Electron overlay shell (apps/desktop/preload.cjs). Undefined
 * when Linaw runs in a normal browser tab.
 */
export interface LinawDesktop {
  platform: string;
  /** Ghost mode: see-through and click-through, so the video underneath stays usable. */
  setGhost: (on: boolean) => void;
  onGhostChange: (listener: (on: boolean) => void) => () => void;
  minimize: () => void;
  close: () => void;
}

declare global {
  interface Window {
    linawDesktop?: LinawDesktop;
  }
}

export const desktop: LinawDesktop | undefined = window.linawDesktop;

/** The compact overlay layout: always in the desktop shell, or `?overlay` in a browser. */
export const isOverlay = desktop !== undefined || new URLSearchParams(window.location.search).has('overlay');
