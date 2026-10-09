/** Client for whisper.cpp's whisper-server. Requests run one at a time, which keeps the transcript in order. */
export class WhisperClient {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly url: string,
    private readonly language: string,
  ) {}

  /** `prompt` primes Whisper with terms it otherwise mishears. Resolves to "" when there were no words. */
  transcribe(wav: Buffer, prompt: string): Promise<string> {
    const run = this.queue.then(() => this.request(wav, prompt));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(wav: Buffer, prompt: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    form.append('language', this.language);
    if (prompt) form.append('prompt', prompt);

    const res = await fetch(`${this.url}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`whisper-server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { text?: unknown; error?: unknown };
    if (typeof body.text !== 'string') throw new Error(`whisper-server sent no text: ${JSON.stringify(body).slice(0, 200)}`);
    return cleanTranscript(body.text);
  }
}

/** What Whisper writes for silence, music or noise instead of speech. */
const NOT_SPEECH = new Set(['you', 'thank you.', 'thanks for watching!', 'thank you for watching.', '.', '...']);

/** Drops sound tags like "[BLANK_AUDIO]" or "(music)". */
export function cleanTranscript(raw: string): string {
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return NOT_SPEECH.has(text.toLowerCase()) ? '' : text;
}
