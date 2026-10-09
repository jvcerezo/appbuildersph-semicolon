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

  constructor(
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onState: (state: ConnectionState) => void,
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
    this.onState('connecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retries = 0;
      this.onState('open');
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const result = parseServerMessage(event.data);
      if (result.ok) this.onMessage(result.message);
      else console.warn('[linaw] dropped message that does not match the contract:', result.error);
    });
    socket.addEventListener('close', () => {
      if (this.disposed) return;
      this.onState('closed');
      const delay = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    });
  }
}
