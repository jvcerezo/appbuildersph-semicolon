/**
 * Demo backend: plays a scripted hearing over the real contract, so the UI can
 * be shown end to end (transcript with translations, cards, summaries with
 * sources) before the real backend exists. It passes `pnpm conformance`, so it
 * also serves as a reference for the backend team.
 *
 *   pnpm demo                          real time (about 2.5 minutes)
 *   pnpm demo --speed 3                3x faster
 *   pnpm demo --offline                report "offline" instead of "listening"
 *   pnpm demo --scenario senate-trial  pick a file from scenarios/
 *   pnpm demo --port 8765
 *
 * It ignores the audio it receives: the hearing is scripted.
 */
import { parseArgs } from 'node:util';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  DEFAULT_PORT,
  parseClientMessage,
  withVersion,
  type Card,
  type ClientMessage,
  type Language,
  type ServerMessage,
  type Unversioned,
} from '@linaw/contract';
import { lintScenario, listScenarios, loadScenario, type Scenario } from './scenario';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: String(DEFAULT_PORT) },
    scenario: { type: 'string', default: 'senate-trial' },
    speed: { type: 'string', default: '1' },
    offline: { type: 'boolean', default: false },
  },
});

const port = Number(args.port);
const speed = Math.max(0.1, Number(args.speed) || 1);
const REPLY_DELAY_MS = 900;

if (!listScenarios().includes(args.scenario)) {
  console.error(`Unknown scenario "${args.scenario}". Available: ${listScenarios().join(', ')}`);
  process.exit(1);
}
const scenario: Scenario = loadScenario(args.scenario);
const problems = lintScenario(scenario);
if (problems.length > 0) {
  console.error(`Scenario "${args.scenario}" has problems:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

const wss = new WebSocketServer({ host: '127.0.0.1', port });
console.log(`Linaw demo backend on ws://localhost:${port}`);
console.log(`  scenario: ${args.scenario} (${scenario.timeline.length} events), speed ${speed}x${args.offline ? ', offline' : ''}`);

wss.on('connection', (socket) => {
  console.log('[demo] client connected');
  const session = new DemoSession(socket);
  socket.on('message', (data, isBinary) => session.receive(data, isBinary));
  socket.on('close', () => {
    session.dispose();
    console.log('[demo] client disconnected');
  });
});

class DemoSession {
  private timers: NodeJS.Timeout[] = [];
  private startedAt: number | null = null;
  private language: Language = 'tl';
  private audioBytes = 0;
  /** Final transcript segments sent so far, with the time they were said. */
  private said = new Map<string, number>();
  private cards = new Map<string, Card>();

  constructor(private readonly socket: WebSocket) {
    this.send({ type: 'status', status: 'waiting', title: scenario.title });
  }

  receive(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.audioBytes += rawLength(data);
      return;
    }
    const result = parseClientMessage(data.toString());
    if (!result.ok) {
      console.warn(`[demo] rejected message: ${result.error}`);
      this.send({ type: 'error', code: 'bad_request', message: result.error });
      return;
    }
    this.handle(result.message);
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  private handle(message: ClientMessage): void {
    console.log(`[demo] <- ${message.type}`);
    switch (message.type) {
      case 'session.start':
        this.language = message.preferences.language;
        this.start();
        break;
      case 'session.stop':
        this.dispose();
        console.log(`[demo] session stopped after ${(this.audioBytes / 1024).toFixed(0)} KiB of audio`);
        this.send({ type: 'status', status: 'stopped' });
        break;
      case 'preferences.update':
        this.language = message.preferences.language;
        break;
      case 'what_said.request': {
        const stage = this.latest(scenario.replies.whatSaid);
        this.later(() =>
          stage
            ? this.send({
                type: 'what_said.result',
                requestId: message.requestId,
                windowSec: message.windowSec,
                points: stage.points,
                sources: stage.sources.filter((id) => this.said.has(id)),
              })
            : this.send({
                type: 'what_said.result',
                requestId: message.requestId,
                windowSec: message.windowSec,
                points: ['Wala pang masyadong nasasabi. Hintayin ang susunod na bahagi ng pagdinig.'],
              }),
        );
        break;
      }
      case 'summary.request':
        this.later(() => this.send({ type: 'summary.result', requestId: message.requestId, ...this.summary() }));
        break;
      case 'ask': {
        const question = message.question.toLowerCase();
        const match = scenario.replies.answers.find((a) => a.match.some((word) => question.includes(word.toLowerCase())));
        const sources = match?.sources.filter((id) => this.said.has(id)) ?? [];
        this.later(() =>
          this.send({
            type: 'answer',
            requestId: message.requestId,
            question: message.question,
            // Only answer from what has actually been said so far.
            ...(match && sources.length > 0 ? { text: match.text, sources } : { text: scenario.replies.fallbackAnswer }),
          }),
        );
        break;
      }
      case 'ask.audio':
        // The scripted demo can't hear; say so instead of pretending.
        this.send({
          type: 'error',
          code: 'model_unavailable',
          message: 'Voice questions need the real backend. Type your question instead.',
          requestId: message.requestId,
        });
        break;
      case 'card.simplify': {
        const card = this.cards.get(message.cardId);
        if (!card) {
          this.send({ type: 'error', code: 'bad_request', message: 'Unknown card', requestId: message.requestId });
          break;
        }
        const simpler = { ...card, ...scenario.simplified[card.id] };
        this.later(() => this.send({ type: 'card', card: simpler, requestId: message.requestId }));
        break;
      }
    }
  }

  private start(): void {
    this.dispose();
    this.startedAt = Date.now();
    this.audioBytes = 0;
    this.said.clear();
    this.send({ type: 'status', status: args.offline ? 'offline' : 'listening', title: scenario.title });
    for (const { at, message } of scenario.timeline) {
      this.timers.push(setTimeout(() => this.send(this.prepare(message)), (at * 1000) / speed));
    }
  }

  private elapsed(): number {
    // Real seconds, matching the UI's clock, even when the script runs faster.
    return this.startedAt === null ? 0 : Math.round((Date.now() - this.startedAt) / 1000);
  }

  /** Stamp the real elapsed time and fit translations to the user's language. */
  private prepare(message: ServerMessage): ServerMessage {
    const t = this.elapsed();
    if (message.type === 'card') return { ...message, card: { ...message.card, t } };
    if (message.type === 'transcript.segment') {
      const { translation, ...rest } = message;
      // The hearing is in English: an English-speaking user needs no translation.
      return translation && translation.language === this.language ? { ...rest, t, translation } : { ...rest, t };
    }
    if ('t' in message) return { ...message, t };
    return message;
  }

  /** The last staged reply whose trigger segment has been said. */
  private latest<T extends { after: string }>(stages: T[]): T | undefined {
    return stages.filter((s) => this.said.has(s.after)).at(-1);
  }

  private summary() {
    const { overviews, events, openIssues } = scenario.replies.summary;
    const ready = events.filter((e) => e.sources.every((id) => this.said.has(id)));
    return {
      overview: this.latest(overviews)?.text ?? 'Kasisimula pa lang ng pagdinig. Wala pang maibubuod.',
      events: ready.map((e) => ({ ...e, t: this.said.get(e.sources[0] ?? '') ?? 0 })),
      openIssue: openIssues.filter((o) => this.said.has(o.after) && !(o.until && this.said.has(o.until))).at(-1)?.text,
    };
  }

  private later(fn: () => void): void {
    this.timers.push(setTimeout(fn, REPLY_DELAY_MS));
  }

  private send(message: Unversioned<ServerMessage> | ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    const full = withVersion(message) as ServerMessage;
    if (full.type === 'card') this.cards.set(full.card.id, full.card);
    if (full.type === 'transcript.segment' && full.final) this.said.set(full.id, full.t);
    console.log(`[demo] -> ${full.type}`);
    this.socket.send(JSON.stringify(full));
  }
}

function rawLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, b) => sum + b.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}
