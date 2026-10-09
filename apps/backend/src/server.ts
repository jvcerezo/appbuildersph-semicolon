/**
 * Linaw backend. Listens on ws://127.0.0.1:8765 and speaks the contract in
 * packages/contract, like tools/mock-server but with real speech-to-text
 * (whisper.cpp) and explanations (Ollama), all on this computer.
 *
 *   pnpm backend          run it
 *   pnpm dev:backend      UI + backend, restarting on changes
 *
 * Settings come from the environment or apps/backend/.env (see .env.example).
 */
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { parseClientMessage } from '@linaw/contract';
import { loadConfig, type Config } from './config';
import { checkHealth, printHealth } from './health';
import { Session } from './session';
import { WhisperClient } from './stt/whisper';
import { encode, type Outgoing } from './wire';

try {
  process.loadEnvFile();
} catch {
  // No .env file: defaults and the real environment apply.
}

const config = loadConfigOrExit();
// One local whisper-server, shared by every connection; it transcribes one clip at a time.
const whisper = new WhisperClient(config.whisperUrl, config.whisperLanguage);
const sessions = new Set<Session>();
const wss = new WebSocketServer({ host: '127.0.0.1', port: config.port });

wss.on('listening', () => {
  console.log(`Linaw backend on ws://localhost:${config.port}`);
  void checkHealth(config).then(printHealth);
});

wss.on('error', (err) => {
  if ('code' in err && err.code === 'EADDRINUSE') {
    console.error(`[backend] Port ${config.port} is already in use. Is the mock backend running? It uses the same port; stop it first.`);
  } else {
    console.error('[backend]', err);
  }
  process.exit(1);
});

wss.on('connection', (socket) => {
  console.log('[backend] UI connected');
  const session = new Session({ config, whisper }, (message) => sendTo(socket, message));
  sessions.add(session);

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      session.audio(toBuffer(data));
      return;
    }
    const result = parseClientMessage(data.toString());
    if (!result.ok) {
      console.warn(`[backend] rejected message: ${result.error}`);
      sendTo(socket, { type: 'error', code: 'bad_request', message: result.error });
      return;
    }
    session.handle(result.message);
  });

  socket.on('close', () => {
    session.dispose();
    sessions.delete(session);
    console.log('[backend] UI disconnected');
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const session of sessions) session.dispose();
    wss.close();
    process.exit(0);
  });
}

function sendTo(socket: WebSocket, message: Outgoing): void {
  const text = encode(message);
  if (text !== null && socket.readyState === socket.OPEN) socket.send(text);
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[backend] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
