/** Linaw backend on ws://localhost:8765: the contract with real whisper.cpp and Ollama. Settings: .env.example. */
import { createServer, type Server } from 'node:http';
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

// On some Windows machines "localhost" resolves only to ::1, so listen on both loopback addresses, never the network.
const LOOPBACK = ['127.0.0.1', '::1'];

const services = createServicesOrExit();
const { config } = services;
const sessions = new Set<Session>();
const wss = new WebSocketServer({ noServer: true });
const servers: Server[] = [];
let listening = 0;

for (const host of LOOPBACK) {
  const server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('Linaw backend: connect with a WebSocket.\n');
  });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  server.on('error', (err) => {
    const code = 'code' in err ? err.code : undefined;
    if (host === '::1' && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) return; // no IPv6 here
    if (code === 'EADDRINUSE') {
      console.error(`[backend] Port ${config.port} is already in use. Is the demo backend (pnpm demo) running? It uses the same port; stop it first.`);
    } else {
      console.error('[backend]', err);
    }
    process.exit(1);
  });
  server.listen(config.port, host, () => {
    if (++listening === 1) ready();
  });
  servers.push(server);
}

function ready(): void {
  console.log(`Linaw backend on ws://localhost:${config.port} (${services.glossary.size} glossary terms)`);
  void checkHealth(config).then((checks) => {
    printHealth(checks);
    // Avoid a cold start on the first card.
    return services.ai
      .warmUp()
      .then(() => console.log(`  ✓ ${services.ai.model} loaded`))
      .catch((err: unknown) => console.warn(`  ✗ couldn't load ${services.ai.model}: ${err instanceof Error ? err.message : String(err)}`));
  });
}

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
    for (const server of servers) server.close();
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
