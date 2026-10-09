import type { ClientMessage, Preferences } from '@linaw/contract';
import type { Outgoing } from './wire';

export type Send = (message: Outgoing) => void;

/** What Chrome's and Electron's MediaRecorder produce: WebM with Opus audio. */
const SUPPORTED_AUDIO = /^(audio|video)\/webm\b/i;

/**
 * One UI connection. Answers its messages and keeps what it has heard so far.
 * A new connection (e.g. a page reload) starts a fresh session.
 */
export class Session {
  private preferences: Preferences = { level: 'simple', language: 'tl' };
  private listening = false;
  private audioBytes = 0;

  constructor(private readonly send: Send) {
    this.send({ type: 'status', status: 'waiting' });
  }

  handle(message: ClientMessage): void {
    switch (message.type) {
      case 'session.start':
        this.preferences = message.preferences;
        if (!SUPPORTED_AUDIO.test(message.mimeType)) {
          this.listening = false;
          this.send({
            type: 'error',
            code: 'unsupported_audio',
            message: `Linaw can't read "${message.mimeType}" audio. Use Chrome, Edge or the Linaw desktop app.`,
          });
          return;
        }
        this.listening = true;
        this.audioBytes = 0;
        console.log(`[backend] listening to ${message.source} (${message.mimeType}), ${this.describePreferences()}`);
        this.send({ type: 'status', status: 'waiting' });
        break;

      case 'session.stop':
        this.listening = false;
        console.log(`[backend] stopped after ${(this.audioBytes / 1024).toFixed(0)} KiB of audio`);
        this.send({ type: 'status', status: 'stopped' });
        break;

      case 'preferences.update':
        this.preferences = message.preferences;
        console.log(`[backend] preferences: ${this.describePreferences()}`);
        break;

      case 'what_said.request':
      case 'summary.request':
      case 'ask':
      case 'card.simplify':
        this.send({
          type: 'error',
          code: 'internal',
          message: 'This part of Linaw isn’t ready yet.',
          requestId: message.requestId,
        });
        break;
    }
  }

  /** A binary frame: the next piece of the WebM stream announced by `session.start`. */
  audio(chunk: Buffer): void {
    if (!this.listening) return;
    this.audioBytes += chunk.length;
  }

  dispose(): void {
    this.listening = false;
  }

  private describePreferences(): string {
    return `${this.preferences.language}, ${this.preferences.level}`;
  }
}
