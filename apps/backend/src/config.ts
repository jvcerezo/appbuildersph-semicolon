import { DEFAULT_PORT } from '@linaw/contract';

/**
 * Backend settings, read once from the environment (or `apps/backend/.env`).
 * Every service URL must point at this computer: Linaw never sends anything
 * off the machine.
 */
export interface Config {
  port: number;
  ffmpegPath: string;
  whisperUrl: string;
  /** Whisper language code (`en`, `tl`), or `auto` to detect it per clip. */
  whisperLanguage: string;
  ollamaUrl: string;
  ollamaModel: string;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function localUrl(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: ${value}`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`${name} must point at this computer (127.0.0.1 or localhost), not ${url.hostname}.`);
  }
  return url.origin;
}

export function loadConfig(): Config {
  const port = Number(process.env.LINAW_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`LINAW_PORT is not a port number: ${process.env.LINAW_PORT}`);
  return {
    port,
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    whisperUrl: localUrl('WHISPER_URL', 'http://127.0.0.1:8178'),
    whisperLanguage: process.env.WHISPER_LANGUAGE || 'en',
    ollamaUrl: localUrl('OLLAMA_URL', 'http://127.0.0.1:11434'),
    ollamaModel: process.env.OLLAMA_MODEL || 'gemma3:4b',
  };
}
