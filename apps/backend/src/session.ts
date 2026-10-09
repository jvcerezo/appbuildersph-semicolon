import type { ClientMessage, Preferences, TermRef } from '@linaw/contract';
import { PauseCutter, type Utterance } from './audio/cutter';
import { FfmpegDecoder, SAMPLE_RATE } from './audio/decoder';
import { toWav } from './audio/wav';
import { checkedCard } from './cards';
import { AiUnavailableError } from './llm/ollama';
import type { Services } from './services';
import type { Outgoing } from './wire';

export type Send = (message: Outgoing) => void;

type StartMessage = Extract<ClientMessage, { type: 'session.start' }>;

const SUPPORTED_AUDIO = /^(audio|video)\/webm\b/i;

// Whisper can't tell speakers apart.
const SPEAKER = 'Speaker';

const CONTEXT_LINES = 2;

/** Unique per run, so ids never collide with lines an open UI already shows. */
const RUN = Date.now().toString(36);

interface Stream {
  decoder: FfmpegDecoder;
  startedAt: number;
  offsetSec: number;
}

export interface Line {
  id: string;
  t: number;
  text: string;
}

/** One UI connection. Stop then start on it is a pause: transcript, cards and clock carry on. */
export class Session {
  private preferences: Preferences = { level: 'simple', language: 'tl' };
  private clockZero: number | null = null;
  private stream: Stream | null = null;
  private readonly lines: Line[] = [];
  private lineCount = 0;
  private readonly explained = new Set<string>();
  private readonly work = new Set<Promise<unknown>>();
  private disposed = false;
  private sttFailing = false;
  private aiFailing = false;

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

  audio(chunk: Buffer): void {
    this.stream?.decoder.write(chunk);
  }

  dispose(): void {
    this.disposed = true;
    this.stream?.decoder.kill();
    this.stream = null;
  }

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
      .transcribe(wav, this.services.whisperPrompt)
      .then((text) => {
        this.sttFailing = false;
        if (this.disposed || text === '') return;
        this.addLine({ id, t, text });
        const behind = (Date.now() - stream.startedAt) / 1000 - (utterance.startSec + utterance.durationSec);
        const whisperSec = (Date.now() - cutAt) / 1000;
        console.log(`[backend] ${id} @${t}s (${behind.toFixed(1)} s behind, whisper ${whisperSec.toFixed(1)} s): ${text}`);
      })
      .catch((err: unknown) => {
        console.error(`[backend] transcription failed: ${describe(err)}`);
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

  private addLine(line: Line): void {
    this.lines.push(line);
    const found = this.services.finder.find(line.text);
    const terms: TermRef[] = found.map((term) => ({ text: term.text, cardId: cardId(term.entryId) }));
    this.send({ type: 'transcript.segment', id: line.id, t: line.t, speaker: SPEAKER, text: line.text, terms, final: true });

    for (const { entryId } of found) {
      if (this.explained.has(entryId)) continue;
      this.explained.add(entryId);
      this.explain(entryId, line);
    }
  }

  private explain(entryId: string, line: Line): void {
    const entry = this.services.glossary.get(entryId);
    if (!entry) return;
    const id = cardId(entryId);
    const { t } = line;
    this.send({ type: 'card.pending', id, term: entry.term, t });

    const startedAt = Date.now();
    const job = checkedCard({ id, t, entry, before: this.linesBefore(line), line: line.text, preferences: this.preferences, ai: this.services.ai }).then(
      ({ card, aiError }) => {
        if (aiError !== undefined) this.aiProblem(aiError);
        if (this.disposed) return;
        this.send({ type: 'card', card });
        console.log(`[backend] card "${card.term}" (${card.kind}, ${((Date.now() - startedAt) / 1000).toFixed(1)} s): ${card.now}`);
      },
    );
    this.track(job);
  }

  private linesBefore(line: Line): string[] {
    const index = this.lines.indexOf(line);
    return this.lines.slice(Math.max(0, index - CONTEXT_LINES), Math.max(0, index)).map((l) => l.text);
  }

  private aiProblem(err: unknown): void {
    console.error(`[backend] AI failed: ${describe(err)}`);
    if (!(err instanceof AiUnavailableError) || this.aiFailing || this.disposed) return;
    this.aiFailing = true;
    this.send({
      type: 'error',
      code: 'model_unavailable',
      message: 'Linaw’s AI isn’t running, so explanations are limited. Open the Ollama app.',
    });
  }

  private track(job: Promise<unknown>): void {
    this.work.add(job);
    void job.finally(() => this.work.delete(job));
  }

  private describePreferences(): string {
    return `${this.preferences.language}, ${this.preferences.level}`;
  }
}

function cardId(entryId: string): string {
  return `${RUN}-c-${entryId}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
