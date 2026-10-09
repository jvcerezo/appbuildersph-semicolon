/**
 * Mock Linaw backend. Speaks the contract exactly like the real one will, so
 * the UI can be built and demoed without Ollama or speech-to-text running.
 *
 *   pnpm mock                             default scenario, real time
 *   pnpm mock --speed 4                   4x faster
 *   pnpm mock --offline                   report "offline" instead of "listening"
 *   pnpm mock --scenario impeachment-day3 pick a file from scenarios/
 *   pnpm mock --port 8765
 */
import { parseArgs } from 'node:util';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  DEFAULT_PORT,
  parseClientMessage,
  withVersion,
  type ClientMessage,
  type ServerMessage,
  type Unversioned,
} from '@linaw/contract';
import { listScenarios, loadScenario, type Scenario } from './scenario';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: String(DEFAULT_PORT) },
    scenario: { type: 'string', default: 'impeachment-day3' },
    speed: { type: 'string', default: '1' },
    offline: { type: 'boolean', default: false },
  },
});

const port = Number(args.port);
const speed = Math.max(0.1, Number(args.speed) || 1);
const replyDelayMs = 900;

if (!listScenarios().includes(args.scenario)) {
  console.error(`Unknown scenario "${args.scenario}". Available: ${listScenarios().join(', ')}`);
  process.exit(1);
}
const scenario: Scenario = loadScenario(args.scenario);

const wss = new WebSocketServer({ host: '127.0.0.1', port });
console.log(`Linaw mock backend on ws://localhost:${port}`);
console.log(`  scenario: ${args.scenario} (${scenario.timeline.length} events), speed ${speed}x${args.offline ? ', offline' : ''}`);

wss.on('connection', (socket) => {
  console.log('[mock] client connected');
  const session = new MockSession(socket);
  socket.on('message', (data, isBinary) => session.receive(data, isBinary));
  socket.on('close', () => {
    session.dispose();
    console.log('[mock] client disconnected');
  });
});

class MockSession {
  private timers: NodeJS.Timeout[] = [];
  private startedAt: number | null = null;
  private audioBytes = 0;
  private sentCards = new Map<string, Extract<ServerMessage, { type: 'card' }>['card']>();

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
      console.warn(`[mock] rejected message: ${result.error}`);
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
    console.log(`[mock] <- ${message.type}`);
    switch (message.type) {
      case 'session.start':
        this.start();
        break;
      case 'session.stop':
        this.dispose();
        console.log(`[mock] session stopped after ${(this.audioBytes / 1024).toFixed(0)} KiB of audio`);
        this.startedAt = null;
        this.send({ type: 'status', status: 'stopped' });
        break;
      case 'preferences.update':
        break;
      case 'what_said.request':
        this.later(() =>
          this.send({
            type: 'what_said.result',
            requestId: message.requestId,
            windowSec: message.windowSec,
            points: scenario.replies.whatSaid,
          }),
        );
        break;
      case 'summary.request':
        this.later(() =>
          this.send({ type: 'summary.result', requestId: message.requestId, ...scenario.replies.summary }),
        );
        break;
      case 'ask': {
        const question = message.question.toLowerCase();
        const match = scenario.replies.answers.find((a) => question.includes(a.match.toLowerCase()));
        this.later(() =>
          this.send({
            type: 'answer',
            requestId: message.requestId,
            question: message.question,
            text: match?.text ?? scenario.replies.fallbackAnswer,
          }),
        );
        break;
      }
      case 'card.simplify': {
        const card = this.sentCards.get(message.cardId);
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
    this.send({ type: 'status', status: args.offline ? 'offline' : 'listening', title: scenario.title });
    for (const { at, message } of scenario.timeline) {
      this.timers.push(setTimeout(() => this.send(this.stamp(message)), (at * 1000) / speed));
    }
  }

  /** Replace the scripted `t` with the real elapsed session time. */
  private stamp(message: ServerMessage): ServerMessage {
    const t = this.startedAt === null ? 0 : Math.round((Date.now() - this.startedAt) / 1000);
    if (message.type === 'card') return { ...message, card: { ...message.card, t } };
    if ('t' in message) return { ...message, t };
    return message;
  }

  private later(fn: () => void): void {
    this.timers.push(setTimeout(fn, replyDelayMs));
  }

  private send(message: Unversioned<ServerMessage> | ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    const full = withVersion(message) as ServerMessage;
    if (full.type === 'card') this.sentCards.set(full.card.id, full.card);
    console.log(`[mock] -> ${full.type}`);
    this.socket.send(JSON.stringify(full));
  }
}

function rawLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, b) => sum + b.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}
