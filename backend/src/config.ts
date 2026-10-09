import { DEFAULT_PORT } from '@linaw/contract';

/** From the environment or backend/.env. Every URL must point at this computer. */
export type SttEngine = 'service' | 'whisper-server';

export interface Config {
  port: number;
  ffmpegPath: string;
  /** `service`: the speech service in stt/ (Soniox online, local Whisper offline). `whisper-server`: whisper.cpp only. */
  stt: SttEngine;
  sttUrl: string;
  whisperUrl: string;
  /** `en`, `tl` or `auto`. */
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
  const stt = process.env.STT || 'service';
  if (stt !== 'service' && stt !== 'whisper-server') throw new Error(`STT must be "service" or "whisper-server", not "${stt}".`);
  return {
    port,
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    stt,
    sttUrl: localUrl('STT_URL', 'http://127.0.0.1:8000'),
    whisperUrl: localUrl('WHISPER_URL', 'http://127.0.0.1:8178'),
    whisperLanguage: process.env.WHISPER_LANGUAGE || 'en',
    ollamaUrl: localUrl('OLLAMA_URL', 'http://127.0.0.1:11434'),
    ollamaModel: process.env.OLLAMA_MODEL || 'gemma4:e4b',
  };
}
