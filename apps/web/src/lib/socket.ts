import {
  DEFAULT_PORT,
  parseServerMessage,
  withVersion,
  type ClientMessage,
  type ServerMessage,
  type Unversioned,
} from '@linaw/contract';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? `ws://localhost:${DEFAULT_PORT}`;

const RETRY_MS = [500, 1000, 2000, 4000];

/**
 * The only place the UI talks to the backend. Every incoming message is
 * validated against the contract; anything that doesn't match is dropped.
 */
export class BackendSocket {
  private socket: WebSocket | null = null;
  private retries = 0;
  private retryTimer: number | undefined;
  private disposed = false;
  /** Set by a `tts.audio` header, consumed by the binary frame that follows it. */
  private pendingAudio: { requestId: string; mimeType: string } | null = null;

  constructor(
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onState: (state: ConnectionState) => void,
    private readonly onAudio: (requestId: string, blob: Blob) => void,
    private readonly url = BACKEND_URL,
  ) {
    this.connect();
  }

  send(message: Unversioned<ClientMessage>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(withVersion(message)));
    return true;
  }

  sendAudio(chunk: Blob): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(chunk);
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.retryTimer);
    this.socket?.close();
  }

  private connect(): void {
    // Report "connecting" only on a fresh attempt; while retrying stay "closed",
    // so the UI keeps explaining why it can't listen yet.
    if (this.retries === 0) this.onState('connecting');
    const socket = new WebSocket(this.url);
    socket.binaryType = 'blob'; // the default, but made explicit: tts.audio pairing below relies on it
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retries = 0;
      this.onState('open');
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        // The binary frame always follows a `tts.audio` header on this same connection.
        const pending = this.pendingAudio;
        this.pendingAudio = null;
        if (pending) this.onAudio(pending.requestId, new Blob([event.data as Blob], { type: pending.mimeType }));
        return;
      }
      const result = parseServerMessage(event.data);
      if (!result.ok) {
        console.warn('[linaw] dropped message that does not match the contract:', result.error);
        return;
      }
      if (result.message.type === 'tts.audio') {
        this.pendingAudio = { requestId: result.message.requestId, mimeType: result.message.mimeType };
        return;
      }
      this.onMessage(result.message);
    });
    socket.addEventListener('close', () => {
      if (this.disposed) return;
      this.onState('closed');
      const delay = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    });
  }
}
