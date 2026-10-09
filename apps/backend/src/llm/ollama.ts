import type { z } from 'zod';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonRequest<T> {
  messages: ChatMessage[];
  format: Record<string, unknown>;
  /** Checks the answer; Ollama's `format` is not a guarantee. */
  schema: z.ZodType<T>;
  maxTokens: number;
  timeoutMs?: number;
}

/** Button presses go first: a person is waiting for them. */
export type Priority = 'user' | 'card';

/** Maps to the contract's `model_unavailable`. */
export class AiUnavailableError extends Error {}

interface Job {
  priority: Priority;
  run: () => Promise<void>;
}

/** One request at a time (a 6 GB graphics card holds one model), JSON checked with zod, one retry. */
export class OllamaClient {
  private readonly waiting: Job[] = [];
  private busy = false;

  constructor(
    private readonly url: string,
    readonly model: string,
  ) {}

  json<T>(request: JsonRequest<T>, priority: Priority): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ priority, run: () => this.attempt(request).then(resolve, reject) });
      this.next();
    });
  }

  /** A cold load took over a minute in tests, so load the model up front. */
  async warmUp(): Promise<void> {
    const res = await fetch(`${this.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, keep_alive: '30m' }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  private next(): void {
    if (this.busy) return;
    const urgent = this.waiting.findIndex((job) => job.priority === 'user');
    const [job] = this.waiting.splice(urgent === -1 ? 0 : urgent, 1);
    if (!job) return;
    this.busy = true;
    void job.run().finally(() => {
      this.busy = false;
      this.next();
    });
  }

  private async attempt<T>(request: JsonRequest<T>): Promise<T> {
    try {
      return await this.chat(request);
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;
      return this.chat(request);
    }
  }

  private async chat<T>(request: JsonRequest<T>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          format: request.format,
          stream: false,
          think: false,
          keep_alive: '30m',
          options: { temperature: 0.2, num_predict: request.maxTokens },
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw new Error('Ollama took too long to answer');
      throw new AiUnavailableError(`Ollama is not reachable at ${this.url}`);
    }
    if (res.status === 404) throw new AiUnavailableError(`Ollama doesn't have the model "${this.model}". Run: ollama pull ${this.model}`);
    if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const body = (await res.json()) as { message?: { content?: unknown } };
    const content = body.message?.content;
    if (typeof content !== 'string') throw new Error('Ollama sent no answer');
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new Error(`Ollama's answer is not JSON: ${content.slice(0, 120)}`);
    }
    const parsed = request.schema.safeParse(data);
    if (!parsed.success) throw new Error(`Ollama's answer has the wrong shape: ${content.slice(0, 120)}`);
    return parsed.data;
  }
}
