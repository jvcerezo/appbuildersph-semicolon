/** Linaw backend on ws://127.0.0.1:8765: the mock's contract with real whisper.cpp and Ollama. Settings: .env.example. */
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { parseClientMessage } from '@linaw/contract';
import { loadConfig } from './config';
import { checkHealth, printHealth } from './health';
import { createServices, type Services } from './services';
import { Session } from './session';
import { encode, type Outgoing } from './wire';

try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

const services = createServicesOrExit();
const { config } = services;
const sessions = new Set<Session>();
const wss = new WebSocketServer({ host: '127.0.0.1', port: config.port });

wss.on('listening', () => {
  console.log(`Linaw backend on ws://localhost:${config.port} (${services.glossary.size} glossary terms)`);
  void checkHealth(config).then((checks) => {
    printHealth(checks);
    // Avoid a cold start on the first card.
    return services.ai
      .warmUp()
      .then(() => console.log(`  ✓ ${services.ai.model} loaded`))
      .catch((err: unknown) => console.warn(`  ✗ couldn't load ${services.ai.model}: ${err instanceof Error ? err.message : String(err)}`));
  });
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
  const session = new Session(services, (message) => sendTo(socket, message));
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

function createServicesOrExit(): Services {
  try {
    return createServices(loadConfig());
  } catch (err) {
    console.error(`[backend] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
