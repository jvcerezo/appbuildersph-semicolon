import { WebSocket } from 'ws';

/** What the speech service sends back (see stt/app/stream.py). */
export interface HeardLine {
  text: string;
  /** Seconds since the session started. */
  startSec: number;
  endSec: number;
  /** `false` while the line is still being spoken; it is re-sent until it turns final. */
  final: boolean;
  engine: string;
}

export interface SttStatus {
  /** `listening`, `processing`, `offline` (fell back to the local engine) or `error`. */
  state: string;
  engine: string;
  message: string;
}

export interface SttStreamEvents {
  onLine: (line: HeardLine) => void;
  onStatus: (status: SttStatus) => void;
  onError: (message: string) => void;
}

/**
 * One audio stream to the speech service in stt/: Soniox when online, local Whisper when not,
 * switching mid-stream without losing words. PCM goes in, lines come back on the same socket.
 */
export class SttStream {
  readonly closed: Promise<void>;
  private readonly socket: WebSocket;
  private readonly queue: Buffer[] = [];
  private open = false;
  private ending = false;
  private failed = false;

  constructor(
    serviceUrl: string,
    offsetSec: number,
    private readonly events: SttStreamEvents,
  ) {
    this.socket = new WebSocket(`${serviceUrl.replace(/^http/, 'ws')}/ws/stream`);
    this.closed = new Promise((resolve) => this.socket.on('close', () => resolve()));

    this.socket.on('open', () => {
      this.open = true;
      this.socket.send(JSON.stringify({ type: 'start', offset_seconds: offsetSec }));
      for (const chunk of this.queue.splice(0)) this.socket.send(chunk);
      if (this.ending) this.socket.send(JSON.stringify({ type: 'stop' }));
    });
    this.socket.on('message', (data, isBinary) => {
      if (!isBinary) this.receive(data.toString());
    });
    this.socket.on('error', (err) => this.fail(`the speech service isn't answering (${err.message})`));
    this.socket.on('close', () => {
      if (!this.ending) this.fail('the speech service closed the stream');
    });
  }

  push(samples: Int16Array): void {
    if (this.ending || this.failed) return;
    const chunk = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    if (this.open) this.socket.send(chunk);
    else this.queue.push(Buffer.from(chunk));
  }

  /** No more audio: the service finishes the last line, then closes. */
  finish(): void {
    if (this.ending) return;
    this.ending = true;
    if (this.open) this.socket.send(JSON.stringify({ type: 'stop' }));
    else if (this.failed) this.socket.terminate();
  }

  kill(): void {
    this.ending = true;
    this.socket.terminate();
  }

  private receive(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case 'transcript':
        if (typeof message.text !== 'string' || typeof message.start !== 'number' || typeof message.end !== 'number') return;
        this.events.onLine({
          text: message.text,
          startSec: message.start,
          endSec: message.end,
          final: message.final === true,
          engine: String(message.engine ?? ''),
        });
        break;
      case 'status':
        this.events.onStatus({ state: String(message.state), engine: String(message.engine ?? ''), message: String(message.message ?? '') });
        break;
      case 'done':
        this.socket.close();
        break;
    }
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.events.onError(message);
  }
}
