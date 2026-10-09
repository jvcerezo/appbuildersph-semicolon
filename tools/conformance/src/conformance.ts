/**
 * Linaw backend conformance check. Connects to a running backend, plays one
 * session the way the UI does, and reports which contract rules it follows.
 *
 *   pnpm conformance
 *   pnpm conformance --audio hearing.webm       stream a recording (WebM/Ogg Opus) as the UI would
 *   pnpm conformance --audio hearing.webm --fast   stream 4x faster than real time
 *   pnpm conformance --url ws://localhost:9000 --timeout 30
 *
 * Exit code 0 when nothing failed (warnings allowed), 1 otherwise.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import {
  DEFAULT_PORT,
  parseServerMessage,
  withVersion,
  type ClientMessage,
  type ServerMessage,
  type Unversioned,
} from '@linaw/contract';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: `ws://localhost:${DEFAULT_PORT}` },
    audio: { type: 'string' },
    mime: { type: 'string' },
    timeout: { type: 'string', default: '20' },
    fast: { type: 'boolean', default: false },
  },
});

const timeoutMs = Number(args.timeout) * 1000;
/** Roughly the size of one second of MediaRecorder Opus audio. */
const CHUNK_BYTES = 4096;
const CHUNK_INTERVAL_MS = args.fast ? 250 : 1000;

// ------------------------------------------------------------- reporting

type Outcome = 'pass' | 'fail' | 'warn' | 'skip';
const results: { outcome: Outcome; rule: string; detail?: string }[] = [];
const SYMBOL: Record<Outcome, string> = { pass: '✓', fail: '✗', warn: '!', skip: '-' };

function report(outcome: Outcome, rule: string, detail?: string): void {
  results.push({ outcome, rule, detail });
  console.log(`  ${SYMBOL[outcome]} ${rule}${detail ? `\n      ${detail}` : ''}`);
}

// ------------------------------------------------------------- connection

const received: ServerMessage[] = [];
const invalid: string[] = [];
let binaryFromServer = 0;
const waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

function waitFor<T extends ServerMessage>(match: (m: ServerMessage) => m is T, ms = timeoutMs, since = 0): Promise<T | null> {
  const already = received.slice(since).find(match);
  if (already) return Promise.resolve(already);
  return new Promise((resolve) => {
    const waiter = { match, resolve: (m: ServerMessage) => resolve(m as T) };
    waiters.push(waiter);
    setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i !== -1) {
        waiters.splice(i, 1);
        resolve(null);
      }
    }, ms);
  });
}

const is =
  <K extends ServerMessage['type']>(type: K, extra: (m: Extract<ServerMessage, { type: K }>) => boolean = () => true) =>
  (m: ServerMessage): m is Extract<ServerMessage, { type: K }> =>
    m.type === type && extra(m as Extract<ServerMessage, { type: K }>);

function guessMime(path: string): string {
  if (args.mime) return args.mime;
  const ext = extname(path).toLowerCase();
  if (ext === '.webm') return 'audio/webm;codecs=opus';
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg;codecs=opus';
  throw new Error(`Cannot tell the encoding of ${path}. Pass --mime, e.g. --mime "audio/webm;codecs=opus".`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`Linaw conformance check against ${args.url}\n`);

  const socket = new WebSocket(args.url);
  const opened = await new Promise<boolean>((resolve) => {
    socket.once('open', () => resolve(true));
    socket.once('error', () => resolve(false));
  });
  if (!opened) {
    report('fail', `Backend accepts a WebSocket connection at ${args.url}`, 'Is the backend running?');
    return;
  }
  report('pass', 'Backend accepts a WebSocket connection');

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      binaryFromServer++;
      return;
    }
    const raw = data.toString();
    const result = parseServerMessage(raw);
    if (!result.ok) {
      invalid.push(`${result.error}\n      message: ${raw.slice(0, 200)}`);
      return;
    }
    received.push(result.message);
    for (const waiter of [...waiters]) {
      if (waiter.match(result.message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(result.message);
      }
    }
  });
  const send = (message: Unversioned<ClientMessage>) => socket.send(JSON.stringify(withVersion(message)));

  // 1. status on connect
  const hello = await waitFor(is('status'), 5000);
  report(hello ? 'pass' : 'fail', 'Sends `status` as soon as the UI connects', hello ? `status: ${hello.status}` : 'nothing within 5 s');

  // 2. session.start
  const audio = args.audio ? readFileSync(args.audio) : null;
  const mimeType = args.audio ? guessMime(args.audio) : 'audio/webm;codecs=opus';
  const startIndex = received.length;
  send({ type: 'session.start', source: 'file', mimeType, preferences: { level: 'simple', language: 'tl' } });
  const listening = await waitFor(
    is('status', (m) => m.status === 'listening' || m.status === 'offline'),
    timeoutMs,
    startIndex,
  );
  report(
    listening ? 'pass' : 'fail',
    'Replies to `session.start` with `status: listening` (or `offline`)',
    listening ? undefined : `nothing within ${args.timeout} s`,
  );

  // 3. audio -> transcript and cards
  if (audio) {
    const chunks = Math.ceil(audio.length / CHUNK_BYTES);
    console.log(`\n  streaming ${args.audio} (${(audio.length / 1024).toFixed(0)} KiB, ${chunks} chunks)…`);
    for (let offset = 0; offset < audio.length; offset += CHUNK_BYTES) {
      socket.send(audio.subarray(offset, offset + CHUNK_BYTES));
      await sleep(CHUNK_INTERVAL_MS);
    }
    const segment = await waitFor(is('transcript.segment'), timeoutMs, startIndex);
    report(
      segment ? 'pass' : 'fail',
      'Turns audio into `transcript.segment` messages',
      segment ? `first: "${segment.text.slice(0, 60)}"` : `nothing within ${args.timeout} s after the audio`,
    );
    const card = await waitFor(is('card'), timeoutMs, startIndex);
    report(card ? 'pass' : 'warn', 'Explains a term with a `card`', card ? `first: ${card.card.term}` : 'no card — fine if the recording has no jargon');
  } else {
    report('skip', 'Turns audio into transcript and cards', 'pass --audio <file.webm> to test this');
  }

  // 4. help requests: each needs a reply (or an error) with the same requestId
  const helpChecks: { label: string; request: Unversioned<ClientMessage>; reply: ServerMessage['type'] }[] = [
    { label: '`what_said.request` → `what_said.result`', request: { type: 'what_said.request', requestId: 'conf-what', windowSec: 120 }, reply: 'what_said.result' },
    { label: '`summary.request` → `summary.result`', request: { type: 'summary.request', requestId: 'conf-summary' }, reply: 'summary.result' },
    { label: '`ask` → `answer`', request: { type: 'ask', requestId: 'conf-ask', question: 'Ano ang ibig sabihin ng subpoena?' }, reply: 'answer' },
  ];
  for (const check of helpChecks) {
    const requestId = (check.request as { requestId: string }).requestId;
    const since = received.length;
    send(check.request);
    const reply = await waitFor(
      (m): m is ServerMessage => 'requestId' in m && m.requestId === requestId && (m.type === check.reply || m.type === 'error'),
      timeoutMs,
      since,
    );
    if (!reply) report('fail', `Answers ${check.label}`, `no reply with requestId "${requestId}" within ${args.timeout} s`);
    else if (reply.type === 'error') report('warn', `Answers ${check.label}`, `replied with error ${reply.code}: ${reply.message}`);
    else report('pass', `Answers ${check.label}`);
  }

  // 5. card.simplify
  const someCard = received.find(is('card'));
  {
    const since = received.length;
    const cardId = someCard?.card.id ?? 'conformance-unknown-card';
    send({ type: 'card.simplify', requestId: 'conf-simplify', cardId });
    const reply = await waitFor(
      (m): m is ServerMessage => 'requestId' in m && m.requestId === 'conf-simplify',
      timeoutMs,
      since,
    );
    if (someCard) {
      const ok = reply?.type === 'card' && reply.card.id === cardId;
      report(ok ? 'pass' : 'fail', 'Answers `card.simplify` with a `card` that has the same id and the requestId');
    } else {
      const ok = reply?.type === 'error';
      report(ok ? 'pass' : 'warn', 'Rejects `card.simplify` for an unknown card with an `error`', ok ? undefined : 'no error reply');
    }
  }

  // 6. invalid input
  {
    const since = received.length;
    socket.send(JSON.stringify({ v: 1, type: 'conformance.bogus' }));
    const reply = await waitFor(is('error', (m) => m.code === 'bad_request'), 5000, since);
    report(reply ? 'pass' : 'warn', 'Answers an invalid message with `error: bad_request` (and keeps running)');
  }

  // 7. session.stop
  {
    const since = received.length;
    send({ type: 'session.stop' });
    const stopped = await waitFor(is('status', (m) => m.status === 'stopped'), timeoutMs, since);
    report(stopped ? 'pass' : 'fail', 'Replies to `session.stop` with `status: stopped`');
  }

  // 7b. the final summary the UI asks for when a session is finished
  {
    const since = received.length;
    send({ type: 'summary.request', requestId: 'conf-final-summary' });
    const reply = await waitFor(
      (m): m is ServerMessage => 'requestId' in m && m.requestId === 'conf-final-summary',
      timeoutMs,
      since,
    );
    report(
      reply?.type === 'summary.result' ? 'pass' : 'warn',
      'Answers `summary.request` after `session.stop` (the final summary saved with the session)',
      reply?.type === 'summary.result' ? undefined : reply ? `replied with ${reply.type}` : 'no reply',
    );
  }

  // 8. whole-session rules
  report(
    invalid.length === 0 ? 'pass' : 'fail',
    'Every message matches the contract',
    invalid.length === 0 ? `${received.length} messages checked` : invalid.slice(0, 5).join('\n      '),
  );
  report(binaryFromServer === 0 ? 'pass' : 'fail', 'Sends only text (JSON) frames', binaryFromServer ? `${binaryFromServer} binary frames` : undefined);

  const pendingIds = new Set(received.filter(is('card.pending')).map((m) => m.id));
  const cardIds = new Set(received.filter(is('card')).map((m) => m.card.id));
  const failedIds = new Set(received.filter(is('card.failed')).map((m) => m.id));
  const orphans = [...pendingIds].filter((id) => !cardIds.has(id) && !failedIds.has(id));
  const resolvedLabel = 'Every `card.pending` is followed by a `card` (or `card.failed`) with the same id';
  if (pendingIds.size === 0) report('skip', resolvedLabel);
  else report(orphans.length === 0 ? 'pass' : 'warn', resolvedLabel, orphans.length ? `never resolved: ${orphans.join(', ')}` : undefined);
  const strayFailures = [...failedIds].filter((id) => !pendingIds.has(id));
  if (strayFailures.length > 0) report('warn', '`card.failed` only follows a `card.pending`', `no card.pending for: ${strayFailures.join(', ')}`);

  const unknownTermCards = received
    .filter(is('transcript.segment'))
    .flatMap((m) => m.terms.map((t) => t.cardId))
    .filter((id): id is string => id !== undefined && !cardIds.has(id) && !pendingIds.has(id));
  if (unknownTermCards.length > 0) {
    report('warn', 'Transcript terms point at cards that were sent', `no card or card.pending for: ${[...new Set(unknownTermCards)].join(', ')}`);
  }

  socket.close();
}

main()
  .catch((err) => report('fail', 'Conformance run finished', String(err)))
  .finally(() => {
    const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
    console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('warn')} warnings, ${count('skip')} skipped`);
    process.exit(count('fail') > 0 ? 1 : 0);
  });
