import { FfmpegDecoder, SAMPLE_RATE } from './audio/decoder';
import { toWav } from './audio/wav';
import type { Services } from './services';

/** A clip longer than this isn't a question; refuse it rather than spend a minute transcribing. */
const MAX_CLIP_SEC = 40;

/** The UI's push-to-talk recording (base64 WebM/Opus) as 16 kHz mono PCM. */
export function decodeClip(ffmpegPath: string, base64: string): Promise<Int16Array> {
  const bytes = Buffer.from(base64, 'base64');
  return new Promise((resolve, reject) => {
    const parts: Int16Array[] = [];
    let failed: string | null = null;
    const decoder = new FfmpegDecoder(ffmpegPath, {
      onPcm: (samples) => parts.push(samples.slice()),
      onError: (message) => (failed = message),
      onClose: () => {
        if (failed) return reject(new Error(failed));
        const total = parts.reduce((n, p) => n + p.length, 0);
        const pcm = new Int16Array(total);
        let at = 0;
        for (const part of parts) {
          pcm.set(part, at);
          at += part.length;
        }
        resolve(pcm);
      },
    });
    decoder.write(bytes);
    decoder.end();
  });
}

/** The words in a spoken question: the speech service's local Whisper, or whisper.cpp. Never the cloud. */
export async function transcribeClip(services: Services, pcm: Int16Array): Promise<string> {
  if (pcm.length > MAX_CLIP_SEC * SAMPLE_RATE) throw new Error(`clip longer than ${MAX_CLIP_SEC} s`);
  const { config } = services;
  if (config.stt === 'whisper-server') return services.whisper.transcribe(toWav(pcm, SAMPLE_RATE), services.whisperPrompt);
  const res = await fetch(`${config.sttUrl}/api/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`speech service answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { text } = (await res.json()) as { text?: unknown };
  return typeof text === 'string' ? text.trim() : '';
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/**
 * Takes out what the hearing said while the user spoke: on speakers, the mic also picks up the video.
 * Any run of 5+ words that also appears, in order, in a recent hearing line is removed. Shorter runs stay:
 * people quote the term they just heard ("Ano ang stricken from the record?").
 */
export function stripHeard(question: string, recentLines: readonly string[], minRun = 5): string {
  const original = question.split(/\s+/).filter(Boolean);
  const said = original.map((word) => words(word).join(''));
  const heard = recentLines.map(words);
  const leaked = new Array<boolean>(original.length).fill(false);
  for (let i = 0; i < said.length; i++) {
    for (const line of heard) {
      for (let j = 0; j < line.length; j++) {
        let run = 0;
        while (i + run < said.length && j + run < line.length && said[i + run] !== '' && said[i + run] === line[j + run]) run++;
        if (run >= minRun) for (let k = i; k < i + run; k++) leaked[k] = true;
      }
    }
  }
  return original
    .filter((_, i) => !leaked[i])
    .join(' ')
    .replace(/^[\s.,;:!?-]+/, '')
    .trim();
}
