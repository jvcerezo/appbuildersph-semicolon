import type { Card, ClientMessage, Language, Preferences, Status, TermRef, Translation } from '@linaw/contract';
import { PauseCutter, type Utterance } from './audio/cutter';
import { FfmpegDecoder, SAMPLE_RATE } from './audio/decoder';
import { toWav } from './audio/wav';
import { aiCard, checkedCard, draftCard, nowLine, simplerText } from './cards';
import { spot } from './llm/prompts';
import { TermFinder, type FoundTerm } from './terms/finder';
import { answerQuestion, LINES_PER_EVENT, Summarizer, whatWasSaid } from './help';
import { AiUnavailableError } from './llm/ollama';
import { briefContext } from './briefs';
import type { Services } from './services';
import { Translator } from './translate';
import { SttStream, type HeardLine, type SttStatus } from './stt/stream';
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
  /** Set when the speech service transcribes this stream (STT=service). */
  stt: SttStream | null;
  /** Id of the line the speech service is still hearing, reused when it turns final. */
  liveId: string | null;
}

/** Where decoded audio goes: the speech service, or the pause cutter feeding whisper-server. */
interface PcmSink {
  push: (samples: Int16Array) => void;
  end: () => void;
  stt: SttStream | null;
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
  private readonly lineTerms = new Map<string, FoundTerm[]>();
  private readonly lineTranslations = new Map<string, Translation>();
  private readonly spotted = new Map<string, string>();
  private spottedFinder: TermFinder | null = null;
  private readonly work = new Set<Promise<unknown>>();
  private disposed = false;
  private sttFailing = false;
  private aiFailing = false;
  private status: Status = 'waiting';
  private readonly summarizer: Summarizer;
  private readonly translator: Translator;

  constructor(
    private readonly services: Services,
    private readonly send: Send,
  ) {
    this.summarizer = new Summarizer(services.ai, (language) => briefContext(services.briefs, language));
    this.translator = new Translator(services.ai);
    this.setStatus('waiting');
  }

  handle(message: ClientMessage): void {
    switch (message.type) {
      case 'session.start':
        this.start(message);
        break;

      case 'session.stop':
        this.endStream();
        console.log('[backend] stopped');
        this.setStatus('stopped');
        break;

      case 'preferences.update':
        this.preferences = message.preferences;
        console.log(`[backend] preferences: ${this.describePreferences()}`);
        break;

      case 'summary.request':
        if (this.stream === null && this.lines.length > 0) this.finished = true;
        this.summary(message.requestId);
        break;

      case 'card.simplify':
        this.simplify(message.requestId, message.cardId);
        break;

      case 'what_said.request':
        this.whatSaid(message.requestId, message.windowSec);
        break;

      case 'ask':
        this.ask(message.requestId, message.question);
        break;
    }
  }

  audio(chunk: Buffer): void {
    this.stream?.decoder.write(chunk);
  }

  dispose(): void {
    this.disposed = true;
    this.stream?.decoder.kill();
    this.stream?.stt?.kill();
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
    const offsetSec = (now - this.clockZero) / 1000;
    let stream: Stream | null = null;
    const current = (): Stream | null => stream;
    const sink = this.services.config.stt === 'service' ? this.serviceSink(offsetSec, current) : this.whisperSink(current);
    const decoder = new FfmpegDecoder(this.services.config.ffmpegPath, {
      onPcm: sink.push,
      onClose: sink.end,
      onError: (problem) => {
        console.error(`[backend] ${problem}`);
        if (stream === this.stream) {
          this.send({ type: 'error', code: 'internal', message: 'Linaw couldn’t read the audio. Try starting again.' });
        }
      },
    });
    stream = { decoder, epoch: this.epoch, startedAt: now, offsetSec, stt: sink.stt, liveId: null };
    this.stream = stream;
    this.track(decoder.closed);
    if (sink.stt) this.track(sink.stt.closed);

    console.log(`[backend] listening to ${message.source} (${message.mimeType}), ${this.describePreferences()}`);
    this.setStatus('listening');
  }

  private setStatus(status: Status, title?: string): void {
    this.status = status;
    this.send(title === undefined ? { type: 'status', status } : { type: 'status', status, title });
  }

  private reset(): void {
    this.finished = false;
    this.epoch = ++sessionCount;
    this.clockZero = null;
    this.lines.length = 0;
    this.lineCount = 0;
    this.explained.clear();
    this.cards.clear();
    this.lineTerms.clear();
    this.lineTranslations.clear();
    this.spotted.clear();
    this.spottedFinder = null;
    this.summarizer.clear();
  }

  private endStream(): void {
    this.stream?.decoder.end();
    this.stream = null;
  }

  /** STT=service: the speech service hears the stream and picks Soniox or local Whisper itself. */
  private serviceSink(offsetSec: number, current: () => Stream | null): PcmSink {
    const stt = new SttStream(this.services.config.sttUrl, offsetSec, {
      onLine: (line) => {
        const stream = current();
        if (stream) this.streamed(line, stream);
      },
      onStatus: (status) => {
        const stream = current();
        if (stream) this.sttStatus(status, stream);
      },
      onError: (problem) => this.sttProblem(problem),
    });
    return { push: (samples) => stt.push(samples), end: () => stt.finish(), stt };
  }

  /** STT=whisper-server: cut at pauses and send each utterance to whisper.cpp. */
  private whisperSink(current: () => Stream | null): PcmSink {
    const cutter = new PauseCutter((utterance) => {
      const stream = current();
      if (stream) this.heard(utterance, stream);
    });
    return { push: (samples) => cutter.push(samples), end: () => cutter.flush(), stt: null };
  }

  private nextLineId(): string {
    return `${RUN}.${this.epoch}-s${++this.lineCount}`;
  }

  private streamed(line: HeardLine, stream: Stream): void {
    if (this.disposed || stream.epoch !== this.epoch) return;
    this.sttFailing = false;
    const text = line.text.trim();
    const t = Math.round(line.startSec * 10) / 10;
    stream.liveId ??= this.nextLineId();
    const id = stream.liveId;
    if (!line.final) {
      // The line still being spoken: no terms yet, cards come with the final.
      if (text) this.send({ type: 'transcript.segment', id, t, speaker: SPEAKER, text, terms: [], final: false });
      return;
    }
    stream.liveId = null;
    if (!text) return;
    this.addLine({ id, t, text });
    const behind = (Date.now() - stream.startedAt) / 1000 + stream.offsetSec - line.endSec;
    console.log(`[backend] ${id} @${t}s (${behind.toFixed(1)} s behind, ${line.engine}): ${text}`);
  }

  private sttStatus(status: SttStatus, stream: Stream): void {
    if (this.disposed || stream.epoch !== this.epoch) return;
    console.log(`[backend] speech: ${status.state} on ${status.engine}${status.message ? ` (${status.message})` : ''}`);
    if (status.state === 'offline') this.send({ type: 'status', status: 'offline' });
    else if (status.state === 'listening' && status.engine === 'soniox' && status.message) this.send({ type: 'status', status: 'listening' });
    else if (status.state === 'error') this.sttProblem(status.message);
  }

  private sttProblem(problem: string): void {
    console.error(`[backend] speech service: ${problem}`);
    if (this.sttFailing || this.disposed) return;
    this.sttFailing = true;
    this.send({
      type: 'error',
      code: 'model_unavailable',
      message: 'Linaw can’t turn speech into text right now. Check that the speech service is running (pnpm stt).',
    });
  }

  private heard(utterance: Utterance, stream: Stream): void {
    if (this.disposed || stream.epoch !== this.epoch) return;
    const id = this.nextLineId();
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
    if (this.lines.length % LINES_PER_EVENT === 0) {
      this.summarizer.prepare(this.lines.slice(-LINES_PER_EVENT), this.preferences.language);
    }
    const found = this.findTerms(line.text);
    this.sendLine(line, found);

    for (const { entryId, text } of found) {
      if (this.explained.has(entryId)) continue;
      this.explained.add(entryId);
      if (this.services.glossary.has(entryId) || this.services.drafts.has(entryId)) this.explain(entryId, line);
      else this.explainWithAi(entryId, this.services.watchlist.get(entryId)?.term ?? text, line);
    }
    this.spot(line, found);
    this.translate(line, found);
  }

  private findTerms(text: string): FoundTerm[] {
    const found = this.services.finder.find(text);
    for (const term of this.spottedFinder?.find(text) ?? []) {
      const end = term.index + term.text.length;
      if (!found.some((f) => term.index < f.index + f.text.length && end > f.index)) found.push(term);
    }
    return found.sort((a, b) => a.index - b.index);
  }

  private sendLine(line: Line, found: FoundTerm[]): void {
    this.lineTerms.set(line.id, found);
    const terms: TermRef[] = found.map((term) => ({ text: term.text, cardId: this.cardId(term.entryId) }));
    const translation = this.lineTranslations.get(line.id);
    this.send({ type: 'transcript.segment', id: line.id, t: line.t, speaker: SPEAKER, text: line.text, terms, final: true, ...(translation ? { translation } : {}) });
  }

  /** Sends the line again with a translation into the user's language, when the AI has idle time for it. */
  private translate(line: Line, found: FoundTerm[]): void {
    const { epoch } = this;
    const language = this.preferences.language;
    const job = this.translator
      .translate(line.text, language, found.map((term) => term.text))
      .then((text) => {
        if (text === null || this.disposed || epoch !== this.epoch) return;
        this.lineTranslations.set(line.id, { language, text });
        this.sendLine(line, this.lineTerms.get(line.id) ?? found);
      })
      .catch((err: unknown) => console.warn(`[backend] translation skipped: ${describe(err)}`));
    this.track(job);
  }

  /** Watch-list terms: "Explaining…" at once, then the AI's card, or card.failed. */
  private explainWithAi(entryId: string, term: string, line: Line): void {
    const id = this.cardId(entryId);
    this.send({ type: 'card.pending', id, term, t: line.t });
    const { epoch } = this;
    const startedAt = Date.now();
    const job = aiCard({ id, term, t: line.t, before: this.linesBefore(line), line: line.text, preferences: this.preferences, ai: this.services.ai })
      .then(({ card }) => {
        this.aiFailing = false;
        if (this.disposed || epoch !== this.epoch) return;
        this.cards.set(card.id, card);
        this.send({ type: 'card', card });
        console.log(`[backend] AI card "${term}" (${((Date.now() - startedAt) / 1000).toFixed(1)} s): ${card.meaning}`);
      })
      .catch((err: unknown) => {
        this.aiProblem(err);
        if (this.disposed || epoch !== this.epoch) return;
        this.explained.delete(entryId);
        this.send({ type: 'card.failed', id });
      });
    this.track(job);
  }

  /**
   * Jargon the lists missed. Nothing shows until its card is ready, because about half of
   * what the spotter picks turns out not to be jargon; the line is then sent again with the term.
   */
  private spot(line: Line, found: FoundTerm[]): void {
    if (this.services.ai.backlog > 1) return;
    const { epoch } = this;
    const lower = line.text.toLowerCase();
    const job = this.services.ai
      .json(spot({ line: line.text }), 'background')
      .then(async ({ terms }) => {
        const pick = terms
          .map((term) => ({ term, index: lower.indexOf(term.toLowerCase()) }))
          .find(({ term, index }) => {
            const end = index + term.length;
            return (
              index !== -1 &&
              (term.match(/\p{L}/gu)?.length ?? 0) >= 4 &&
              !NOT_JARGON.has(term.toLowerCase()) &&
              !this.explained.has(spottedId(term)) &&
              !found.some((f) => index < f.index + f.text.length && end > f.index)
            );
          });
        if (!pick || this.disposed || epoch !== this.epoch) return;
        const text = line.text.slice(pick.index, pick.index + pick.term.length);
        const entryId = spottedId(text);
        const { card, jargon } = await aiCard({
          id: this.cardId(entryId),
          term: text.charAt(0).toUpperCase() + text.slice(1),
          t: line.t,
          before: this.linesBefore(line),
          line: line.text,
          preferences: this.preferences,
          ai: this.services.ai,
        });
        console.log(`[backend] spotted "${text}"${jargon ? '' : ' (not jargon, dropped)'}`);
        if (!jargon || this.disposed || epoch !== this.epoch || this.explained.has(entryId)) return;
        this.explained.add(entryId);
        this.spotted.set(entryId, text);
        this.spottedFinder = new TermFinder([...this.spotted].map(([id, phrase]) => ({ id, phrases: [phrase] })));
        this.cards.set(card.id, card);
        const current = this.lineTerms.get(line.id) ?? found;
        this.sendLine(line, [...current, { entryId, text, index: pick.index }].sort((a, b) => a.index - b.index));
        this.send({ type: 'card', card });
      })
      .catch((err: unknown) => console.warn(`[backend] spotter skipped a line: ${describe(err)}`));
    this.track(job);
  }

  /** Glossary terms and drafted watch-list terms: the card at once, then the AI's "Right now". */
  private explain(entryId: string, line: Line): void {
    const id = this.cardId(entryId);
    const entry = this.services.glossary.get(entryId);
    const draft = this.services.drafts.get(entryId);
    const card = entry
      ? checkedCard({ id, t: line.t, entry, preferences: this.preferences })
      : draft
        ? draftCard({ id, t: line.t, entry: draft, preferences: this.preferences })
        : null;
    if (!card) return;
    this.cards.set(card.id, card);
    this.send({ type: 'card', card });

    const { epoch } = this;
    const startedAt = Date.now();
    const job = nowLine(card, this.linesBefore(line), line.text, this.services.ai, this.brief(card.language))
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
    const job = whatWasSaid(lines, language, this.services.ai, this.brief(language))
      .then(({ points, sources }) => {
        this.aiFailing = false;
        if (this.disposed) return;
        this.send({ type: 'what_said.result', requestId, windowSec, points, sources });
        console.log(`[backend] what was said (${lines.length} lines, ${((Date.now() - startedAt) / 1000).toFixed(1)} s): ${points.join(' / ')}`);
      })
      .catch((err: unknown) => this.helpFailed(err, requestId, 'Linaw couldn’t look back right now. Try again.'));
    this.track(job);
  }

  /** Reads the whole transcript. The final summary after Stop is still sent if a new session has begun: the UI saves it. */
  private summary(requestId: string): void {
    const lines = [...this.lines];
    const { language } = this.preferences;
    const { epoch } = this;
    const startedAt = Date.now();
    const job = this.summarizer
      .summarize(lines, language)
      .then(({ overview, events, openIssue, title }) => {
        this.aiFailing = false;
        if (this.disposed) return;
        this.send({ type: 'summary.result', requestId, overview, events, ...(openIssue ? { openIssue } : {}) });
        if (title && epoch === this.epoch) this.setStatus(this.status, title);
        console.log(`[backend] summary "${title ?? ''}" (${lines.length} lines, ${events.length} events, ${((Date.now() - startedAt) / 1000).toFixed(1)} s): ${overview}`);
      })
      .catch((err: unknown) => this.helpFailed(err, requestId, 'Linaw couldn’t write the summary. Try again.'));
    this.track(job);
  }

  private ask(requestId: string, question: string): void {
    const { language } = this.preferences;
    const meanings = this.services.finder.find(question).flatMap(({ entryId }) => {
      const entry = this.services.glossary.get(entryId);
      if (!entry) return [];
      return [{ term: entry.term, meaning: (language === 'en' ? entry.en : undefined)?.meaning ?? entry.tl.meaning }];
    });
    const startedAt = Date.now();
    const job = answerQuestion({ question, lines: [...this.lines], meanings, law: this.services.law, language, ai: this.services.ai, context: this.brief(language) })
      .then(({ text, sources }) => {
        this.aiFailing = false;
        if (this.disposed) return;
        this.send({ type: 'answer', requestId, question, text, sources });
        console.log(`[backend] ask "${question}" (${((Date.now() - startedAt) / 1000).toFixed(1)} s): ${text}`);
      })
      .catch((err: unknown) => this.helpFailed(err, requestId, 'Linaw couldn’t answer right now. Try again.'));
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

  /** The case brief for prompts, in `language`. */
  private brief(language: Language): string {
    return briefContext(this.services.briefs, language);
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

/** Hearing words the spotter tends to pick that need no card. */
const NOT_JARGON = new Set([
  'senate', 'senator', 'chair', 'chairman', 'court', 'witness', 'counsel', 'record', 'records', 'registered',
  'session', 'hearing', 'trial', 'government', 'office', 'officer', 'official records', 'your honor', 'mr. president',
]);

function spottedId(term: string): string {
  return `s-${term.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
