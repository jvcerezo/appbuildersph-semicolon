import type { Language } from '@linaw/contract';

export interface TtsResult {
  mimeType: string;
  audio: Buffer;
}

/** The speech service can't do cloud read-aloud right now (offline, not configured, or Soniox failed). */
export class TtsUnavailableError extends Error {}

/** One REST call to the speech service's `/api/tts` (it holds the Soniox key, never this process). */
export async function synthesizeSpeech(sttUrl: string, text: string, language: Language): Promise<TtsResult> {
  let res: Response;
  try {
    res = await fetch(`${sttUrl}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, language }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new TtsUnavailableError(`the speech service isn't answering (${err instanceof Error ? err.message : String(err)})`);
  }
  if (res.status === 503) throw new TtsUnavailableError(await res.text());
  if (!res.ok) throw new Error(`speech service answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const mimeType = res.headers.get('content-type') ?? 'audio/mpeg';
  return { mimeType, audio: Buffer.from(await res.arrayBuffer()) };
}
