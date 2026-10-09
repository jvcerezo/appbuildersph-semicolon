/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the local Linaw backend. Defaults to ws://localhost:8765. */
  readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
