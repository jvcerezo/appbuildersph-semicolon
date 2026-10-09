/**
 * Plays a recording through the backend as if the UI were streaming it live,
 * and prints every message the UI would receive. Tests the whole pipeline
 * (ffmpeg, pause cutter, whisper-server) without opening the UI.
 *
 *   pnpm --filter @linaw/backend replay <audio-or-video-file> [--speed 2]
 */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config';
import { createServices } from '../src/services';
import { Session } from '../src/session';
import { encode, type Outgoing } from '../src/wire';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { speed: { type: 'string', default: '1' } },
});
const file = positionals[0];
if (!file) {
  console.error('Usage: pnpm --filter @linaw/backend replay <audio-or-video-file> [--speed 2]');
  process.exit(1);
}
try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

const config = loadConfig();
const speed = Math.max(0.1, Number(values.speed) || 1);
const [webm, durationSec] = await Promise.all([encodeWebm(file), probeDuration(file)]);
// MediaRecorder sends about one chunk per second; slice the stream the same way.
const chunkCount = Math.max(1, Math.ceil(durationSec));
const chunkSize = Math.ceil(webm.length / chunkCount);
console.log(`Replaying ${file}: ${durationSec.toFixed(1)} s at ${speed}x, ${chunkCount} chunks\n`);

const startedAt = Date.now();
const counts = new Map<string, number>();
const cardsSeen = new Set<string>();
const services = createServices(config);
await services.ai.warmUp().catch((err: unknown) => console.warn(`AI model not loaded: ${err instanceof Error ? err.message : String(err)}`));
const session = new Session(services, print);

session.handle({
  v: 1,
  type: 'session.start',
  source: 'file',
  mimeType: 'audio/webm;codecs=opus',
  preferences: { level: 'simple', language: 'tl' },
});
for (let i = 0; i < chunkCount; i++) {
  session.audio(webm.subarray(i * chunkSize, (i + 1) * chunkSize));
  await new Promise((resolve) => setTimeout(resolve, 1000 / speed));
}
session.handle({ v: 1, type: 'session.stop' });
await session.drained();
session.handle({ v: 1, type: 'what_said.request', requestId: 'replay-what-said', windowSec: 120 });
await session.drained();
session.dispose();

console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)} s:`, Object.fromEntries(counts));

function print(message: Outgoing): void {
  if (encode(message) === null) return; // already logged
  counts.set(message.type, (counts.get(message.type) ?? 0) + 1);
  const at = `[${((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)} s]`;
  switch (message.type) {
    case 'transcript.segment': {
      const terms = message.terms.map((term) => term.text).join(', ');
      console.log(`${at} line @${message.t}s: ${message.text}${terms ? `   [terms: ${terms}]` : ''}`);
      break;
    }
    case 'status':
      console.log(`${at} status: ${message.status}`);
      break;
    case 'card.pending':
      console.log(`${at} explaining "${message.term}"…`);
      break;
    case 'card':
      if (cardsSeen.has(message.card.id)) {
        console.log(`${at} card update ${message.card.term}\n           now:     ${message.card.now}`);
      } else {
        cardsSeen.add(message.card.id);
        console.log(`${at} card (${message.card.kind}) ${message.card.term}\n           meaning: ${message.card.meaning}\n           example: ${message.card.example}\n           now:     ${message.card.now}`);
      }
      break;
    case 'what_said.result':
      console.log(`${at} what was said (${message.windowSec} s):\n${message.points.map((p) => `           - ${p}`).join('\n')}\n           sources: ${(message.sources ?? []).join(', ')}`);
      break;
    default:
      console.log(`${at} ${JSON.stringify(message)}`);
  }
}

/** Re-encodes any input to WebM/Opus, like the browser's MediaRecorder. */
function encodeWebm(input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', 'pipe:1'],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => chunks.push(data));
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${stderr}`))));
  });
}

function probeDuration(input: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, ['-hide_banner', '-i', input], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
    child.on('error', reject);
    child.on('close', () => {
      const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      if (!match) return reject(new Error(`Can't read the duration of ${input}`));
      resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    });
  });
}
