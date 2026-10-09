import { spawn } from 'node:child_process';
import type { Config } from './config';

export interface Check {
  name: string;
  ok: boolean;
  hint: string;
}

export async function checkHealth(config: Config): Promise<Check[]> {
  return Promise.all([checkFfmpeg(config), checkWhisper(config), checkOllama(config)]);
}

export function printHealth(checks: Check[]): void {
  for (const check of checks) {
    console.log(check.ok ? `  ✓ ${check.name}` : `  ✗ ${check.name} — ${check.hint}`);
  }
}

function checkFfmpeg(config: Config): Promise<Check> {
  const check = (ok: boolean): Check => ({
    name: 'ffmpeg',
    ok,
    hint: 'not found. Install it with "winget install Gyan.FFmpeg" and open a new terminal, or set FFMPEG_PATH.',
  });
  return new Promise((resolve) => {
    const child = spawn(config.ffmpegPath, ['-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(check(false)));
    child.on('exit', (code) => resolve(check(code === 0)));
  });
}

async function checkWhisper(config: Config): Promise<Check> {
  const ok = await answers(`${config.whisperUrl}/`);
  return {
    name: `whisper-server (${config.whisperUrl})`,
    ok,
    hint: 'not answering. Start it: whisper-server -m ggml-small.bin --host 127.0.0.1 --port 8178',
  };
}

async function checkOllama(config: Config): Promise<Check> {
  const name = `Ollama model ${config.ollamaModel}`;
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { models?: { name: string }[] };
    const wanted = withTag(config.ollamaModel);
    const ok = (body.models ?? []).some((m) => withTag(m.name) === wanted);
    return { name, ok, hint: `not downloaded. Run: ollama pull ${config.ollamaModel}` };
  } catch {
    return { name, ok: false, hint: 'Ollama is not running. Open the Ollama app, then restart the backend.' };
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Ollama treats "gemma3" and "gemma3:latest" as the same model. */
function withTag(model: string): string {
  return model.includes(':') ? model : `${model}:latest`;
}
