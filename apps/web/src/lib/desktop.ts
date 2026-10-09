/**
 * Bridge to the Electron overlay shell (apps/desktop/preload.cjs). Undefined
 * when Linaw runs in a normal browser tab.
 */
export interface LinawDesktop {
  platform: string;
  /** Ghost mode: see-through and click-through, so the video underneath stays usable. */
  setGhost: (on: boolean) => void;
  onGhostChange: (listener: (on: boolean) => void) => () => void;
  /** `app`: normal window for the library. `overlay`: narrow, always on top, while listening. */
  setMode: (mode: 'app' | 'overlay') => void;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  /**
   * Push to talk: lower the speakers while the user speaks (true), then restore them (false).
   * The hearing transcript is unaffected. Resolves to false when the volume can't be changed.
   */
  duckVolume: (on: boolean) => Promise<boolean>;
}

declare global {
  interface Window {
    linawDesktop?: LinawDesktop;
  }
}

export const desktop: LinawDesktop | undefined = window.linawDesktop;

/** The compact overlay layout while listening: always in the desktop shell, or `?overlay` in a browser. */
export const isOverlay = desktop !== undefined || new URLSearchParams(window.location.search).has('overlay');
