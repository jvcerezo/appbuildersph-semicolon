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
      // Soniox itself typically answers in a few seconds, but the stt service has occasionally taken
      // much longer to turn an already-successful Soniox response into this HTTP response (seen up to
      // ~15 s past Soniox's own reply; root cause not yet pinned down - stt/app/main.py now logs the
      // real duration on every call). Generous on purpose: a slow-but-real answer beats a needless
      // fallback to the on-device voice.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new TtsUnavailableError(`the speech service isn't answering (${err instanceof Error ? err.message : String(err)})`);
  }
  if (res.status === 503) throw new TtsUnavailableError(await res.text());
  if (!res.ok) throw new Error(`speech service answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const mimeType = res.headers.get('content-type') ?? 'audio/mpeg';
  return { mimeType, audio: Buffer.from(await res.arrayBuffer()) };
}
