import type { Card, ClientMessage, Preferences, TermRef } from '@linaw/contract';
import { PauseCutter, type Utterance } from './audio/cutter';
import { FfmpegDecoder, SAMPLE_RATE } from './audio/decoder';
import { toWav } from './audio/wav';
import { checkedCard, nowLine, simplerText } from './cards';
import { whatWasSaid } from './help';
import { AiUnavailableError } from './llm/ollama';
import type { Services } from './services';
import type { Outgoing } from './wire';

export type Send = (message: Outgoing) => void;

type StartMessage = Extract<ClientMessage, { type: 'session.start' }>;

const SUPPORTED_AUDIO = /^(audio|video)\/(webm|ogg)\b/i;

// Whisper can't tell speakers apart.
const SPEAKER = 'Speaker';

const CONTEXT_LINES = 2;

// Keeps the prompt small enough for a quick answer from a 4B model.
const MAX_HELP_LINES = 40;

/** Unique per run, so ids never collide with lines an open UI already shows. */
const RUN = Date.now().toString(36);
let sessionCount = 0;

interface Stream {
  decoder: FfmpegDecoder;
  epoch: number;
  startedAt: number;
  offsetSec: number;
}

export interface Line {
  id: string;
  t: number;
  text: string;
}

/**
 * One UI connection. Stop then start is a pause (Reconnect): transcript, cards and clock carry on.
 * A summary request after stop is the UI finishing the session, so the next start begins a new one.
 */
export class Session {
  private preferences: Preferences = { level: 'simple', language: 'tl' };
  private epoch = ++sessionCount;
  private finished = false;
  private clockZero: number | null = null;
  private stream: Stream | null = null;
  private readonly lines: Line[] = [];
  private lineCount = 0;
  private readonly explained = new Set<string>();
  private readonly cards = new Map<string, Card>();
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

      case 'summary.request':
        if (this.stream === null && this.lines.length > 0) this.finished = true;
        this.notReady(message.requestId);
        break;

      case 'card.simplify':
        this.simplify(message.requestId, message.cardId);
        break;

      case 'what_said.request':
        this.whatSaid(message.requestId, message.windowSec);
        break;

      case 'ask':
        this.notReady(message.requestId);
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
    if (this.finished) this.reset();

    const now = Date.now();
    this.clockZero ??= now;
    let stream: Stream | null = null;
    const cutter = new PauseCutter((utterance) => {
      if (stream) this.heard(utterance, stream);
    });
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
    stream = { decoder, epoch: this.epoch, startedAt: now, offsetSec: (now - this.clockZero) / 1000 };
    this.stream = stream;
    this.track(decoder.closed);

    console.log(`[backend] listening to ${message.source} (${message.mimeType}), ${this.describePreferences()}`);
    this.send({ type: 'status', status: 'listening' });
  }

  private reset(): void {
    this.finished = false;
    this.epoch = ++sessionCount;
    this.clockZero = null;
    this.lines.length = 0;
    this.lineCount = 0;
    this.explained.clear();
    this.cards.clear();
  }

  private endStream(): void {
    this.stream?.decoder.end();
    this.stream = null;
  }

  private notReady(requestId: string): void {
    this.send({ type: 'error', code: 'internal', message: 'This part of Linaw isn’t ready yet.', requestId });
  }

  private heard(utterance: Utterance, stream: Stream): void {
    if (this.disposed || stream.epoch !== this.epoch) return;
    const id = `${RUN}.${this.epoch}-s${++this.lineCount}`;
    const t = Math.round((stream.offsetSec + utterance.startSec) * 10) / 10;
    const cutAt = Date.now();
    const wav = toWav(utterance.samples, SAMPLE_RATE);

    const job = this.services.whisper
      .transcribe(wav, this.services.whisperPrompt)
      .then((text) => {
        this.sttFailing = false;
        if (this.disposed || stream.epoch !== this.epoch || text === '') return;
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
    const terms: TermRef[] = found.map((term) => ({ text: term.text, cardId: this.cardId(term.entryId) }));
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
    const card = checkedCard({ id: this.cardId(entryId), t: line.t, entry, preferences: this.preferences });
    this.cards.set(card.id, card);
    this.send({ type: 'card', card });

    const { epoch } = this;
    const startedAt = Date.now();
    const job = nowLine(card, this.linesBefore(line), line.text, this.services.ai)
      .then((now) => {
        this.aiFailing = false;
        // "Simpler" may have rewritten the card meanwhile; keep its text.
        const latest = this.cards.get(card.id);
        if (this.disposed || epoch !== this.epoch || !latest) return;
        const updated = { ...latest, now };
        this.cards.set(updated.id, updated);
        this.send({ type: 'card', card: updated });
        console.log(`[backend] "${card.term}" right now (${((Date.now() - startedAt) / 1000).toFixed(1)} s): ${now}`);
      })
      .catch((err: unknown) => this.aiProblem(err));
    this.track(job);
  }

  private simplify(requestId: string, cardId: string): void {
    const card = this.cards.get(cardId);
    if (!card) {
      this.send({ type: 'error', code: 'bad_request', message: 'Linaw doesn’t know that card.', requestId });
      return;
    }
    const { epoch } = this;
    const job = simplerText(card, this.services.ai)
      .then((text) => {
        // The AI "Right now" line may have arrived meanwhile; keep it.
        const latest = this.cards.get(cardId);
        if (this.disposed || epoch !== this.epoch || !latest) return;
        const simple: Card = { ...latest, ...text, kind: 'ai' };
        this.cards.set(simple.id, simple);
        this.send({ type: 'card', card: simple, requestId });
      })
      .catch((err: unknown) => this.helpFailed(err, requestId, 'Linaw couldn’t make this simpler. Try again.'));
    this.track(job);
  }

  private whatSaid(requestId: string, windowSec: number): void {
    const lines = this.recentLines(windowSec);
    const { language } = this.preferences;
    const startedAt = Date.now();
    const job = whatWasSaid(lines, language, this.services.ai)
      .then(({ points, sources }) => {
        this.aiFailing = false;
        if (this.disposed) return;
        this.send({ type: 'what_said.result', requestId, windowSec, points, sources });
        console.log(`[backend] what was said (${lines.length} lines, ${((Date.now() - startedAt) / 1000).toFixed(1)} s): ${points.join(' / ')}`);
      })
      .catch((err: unknown) => this.helpFailed(err, requestId, 'Linaw couldn’t look back right now. Try again.'));
    this.track(job);
  }

  /** Lines from the last `windowSec` of the hearing. While paused, the window ends at the last line. */
  private recentLines(windowSec: number): Line[] {
    const last = this.lines.at(-1);
    if (!last) return [];
    const end = this.stream && this.clockZero !== null ? (Date.now() - this.clockZero) / 1000 : last.t;
    return this.lines.filter((line) => line.t >= end - windowSec).slice(-MAX_HELP_LINES);
  }

  private helpFailed(err: unknown, requestId: string, message: string): void {
    console.error(`[backend] help request failed: ${describe(err)}`);
    if (this.disposed) return;
    const code = err instanceof AiUnavailableError ? 'model_unavailable' : 'internal';
    this.send({ type: 'error', code, message, requestId });
  }

  private cardId(entryId: string): string {
    return `${RUN}.${this.epoch}-c-${entryId}`;
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
