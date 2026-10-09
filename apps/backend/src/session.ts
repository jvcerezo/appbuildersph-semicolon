import type { ClientMessage, Preferences } from '@linaw/contract';
import { PauseCutter, type Utterance } from './audio/cutter';
import { FfmpegDecoder, SAMPLE_RATE } from './audio/decoder';
import { toWav } from './audio/wav';
import type { Config } from './config';
import { whisperPrompt } from './stt/vocabulary';
import type { WhisperClient } from './stt/whisper';
import type { Outgoing } from './wire';

export type Send = (message: Outgoing) => void;

export interface Services {
  config: Config;
  whisper: WhisperClient;
}

type StartMessage = Extract<ClientMessage, { type: 'session.start' }>;

/** What Chrome's and Electron's MediaRecorder produce: WebM with Opus audio. */
const SUPPORTED_AUDIO = /^(audio|video)\/webm\b/i;

/** Whisper can't tell speakers apart, so every line gets the same label. */
const SPEAKER = 'Speaker';

/** Unique per backend run, so ids never collide with lines an open UI already shows. */
const RUN = Date.now().toString(36);

/** One `session.start` worth of audio: a fresh WebM stream with its own decoder. */
interface Stream {
  decoder: FfmpegDecoder;
  /** Wall-clock start, to measure how far behind the live audio we are. */
  startedAt: number;
  /** Seconds from the session clock's zero to this stream's first sample. */
  offsetSec: number;
}

export interface Line {
  id: string;
  /** Seconds since the session started. */
  t: number;
  text: string;
}

/**
 * One UI connection. Turns its audio into transcript lines and answers its
 * messages. Stop and start on the same connection is a pause: the transcript
 * and the clock carry on. A new connection (e.g. a page reload) starts fresh.
 */
export class Session {
  private preferences: Preferences = { level: 'simple', language: 'tl' };
  /** When the first `session.start` arrived; `t` values count from here. */
  private clockZero: number | null = null;
  private stream: Stream | null = null;
  private readonly lines: Line[] = [];
  private lineCount = 0;
  private readonly work = new Set<Promise<unknown>>();
  private disposed = false;
  private sttFailing = false;

  constructor(
    private readonly services: Services,
    private readonly send: Send,
  ) {
    this.send({ type: 'status', status: 'waiting' });
  }

  handle(message: ClientMessage): void {
    switch (message.type) {
      case 'session.start':
        this.start(message);
        break;

      case 'session.stop':
        this.endStream();
        console.log('[backend] stopped');
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
    this.stream?.decoder.write(chunk);
  }

  dispose(): void {
    this.disposed = true;
    this.stream?.decoder.kill();
    this.stream = null;
  }

  /** Resolves once every clip heard so far has been transcribed and sent. */
  async drained(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  private start(message: StartMessage): void {
    this.preferences = message.preferences;
    // Each start brings a fresh WebM stream with its own header, so the old decoder can't continue.
    this.endStream();
    if (!SUPPORTED_AUDIO.test(message.mimeType)) {
      this.send({
        type: 'error',
        code: 'unsupported_audio',
        message: `Linaw can't read "${message.mimeType}" audio. Use Chrome, Edge or the Linaw desktop app.`,
      });
      return;
    }

    const now = Date.now();
    this.clockZero ??= now;
    const offsetSec = (now - this.clockZero) / 1000;
    let stream: Stream | null = null;
    const cutter = new PauseCutter(
      (utterance) => {
        if (stream) this.heard(utterance, stream);
      },
      () => {
        if (stream && stream === this.stream) this.send({ type: 'status', status: 'listening' });
      },
    );
    const decoder = new FfmpegDecoder(this.services.config.ffmpegPath, {
      onPcm: (samples) => cutter.push(samples),
      onClose: () => cutter.flush(),
      onError: (problem) => {
        console.error(`[backend] ${problem}`);
        if (stream === this.stream) {
          this.send({ type: 'error', code: 'internal', message: 'Linaw couldn’t read the audio. Try starting again.' });
        }
      },
    });
    stream = { decoder, startedAt: now, offsetSec };
    this.stream = stream;
    this.track(decoder.closed);

    console.log(`[backend] listening to ${message.source} (${message.mimeType}), ${this.describePreferences()}`);
    this.send({ type: 'status', status: 'waiting' });
  }

  /** Lets the current stream finish: ffmpeg decodes what it has and the last clip is transcribed. */
  private endStream(): void {
    this.stream?.decoder.end();
    this.stream = null;
  }

  private heard(utterance: Utterance, stream: Stream): void {
    if (this.disposed) return;
    const id = `${RUN}-s${++this.lineCount}`;
    const t = Math.round((stream.offsetSec + utterance.startSec) * 10) / 10;
    const cutAt = Date.now();
    const wav = toWav(utterance.samples, SAMPLE_RATE);

    const job = this.services.whisper
      .transcribe(wav, whisperPrompt())
      .then((text) => {
        this.sttFailing = false;
        if (this.disposed || text === '') return;
        this.lines.push({ id, t, text });
        this.send({ type: 'transcript.segment', id, t, speaker: SPEAKER, text, terms: [], final: true });

        const behind = (Date.now() - stream.startedAt) / 1000 - (utterance.startSec + utterance.durationSec);
        const whisperSec = (Date.now() - cutAt) / 1000;
        console.log(`[backend] ${id} @${t}s (${behind.toFixed(1)} s behind, whisper ${whisperSec.toFixed(1)} s): ${text}`);
      })
      .catch((err: unknown) => {
        console.error(`[backend] transcription failed: ${err instanceof Error ? err.message : String(err)}`);
        if (this.sttFailing || this.disposed) return;
        this.sttFailing = true;
        this.send({
          type: 'error',
          code: 'model_unavailable',
          message: 'Linaw can’t turn speech into text right now. Check that whisper-server is running.',
        });
      });
    this.track(job);
  }

  private track(job: Promise<unknown>): void {
    this.work.add(job);
    void job.finally(() => this.work.delete(job));
  }

  private describePreferences(): string {
    return `${this.preferences.language}, ${this.preferences.level}`;
  }
}
