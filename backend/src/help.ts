import type { Language, SummaryEvent } from '@linaw/contract';
import type { OllamaClient, Priority } from './llm/ollama';
import { summaryEvent, summaryOverview, whatSaid } from './llm/prompts';
import type { Line } from './session';

const NOTHING_SAID: Record<Language, string> = {
  tl: 'Walang narinig na nagsalita sa nakaraang ilang minuto.',
  en: 'No one was heard speaking in the last few minutes.',
};

const NOTHING_YET: Record<Language, string> = {
  tl: 'Wala pang narinig na nagsalita sa pagdinig.',
  en: 'No one has been heard speaking in the hearing yet.',
};

// Each point is one AI call (~2 s), so three keeps the wait near 6 s.
const MAX_POINTS = 3;
const LINES_PER_POINT = 4;

export const LINES_PER_EVENT = 6;

// The overview prompt has to fit gemma's 4k-token context.
const MAX_OVERVIEW_EVENTS = 30;

export interface WhatSaid {
  points: string[];
  /** One quoted line per point: the longest line of its part. */
  sources: string[];
}

export async function whatWasSaid(lines: Line[], language: Language, ai: OllamaClient): Promise<WhatSaid> {
  if (lines.length === 0) return { points: [NOTHING_SAID[language]], sources: [] };
  const parts = split(lines, Math.min(MAX_POINTS, Math.ceil(lines.length / LINES_PER_POINT)));
  const answers = await Promise.all(
    parts.map((part) => ai.json(whatSaid({ lines: part.map((line) => line.text), language }), 'user')),
  );
  return { points: answers.map((answer) => answer.point), sources: parts.map((part) => longest(part).id) };
}

export interface Summary {
  overview: string;
  events: SummaryEvent[];
  openIssue?: string;
  /** Name for the session, when there was anything to summarize. */
  title?: string;
}

/** One timeline event per stretch of lines. Finished stretches are kept, so each summary only reads what is new. */
export class Summarizer {
  private readonly events = new Map<string, Promise<SummaryEvent>>();

  constructor(private readonly ai: OllamaClient) {}

  async summarize(lines: Line[], language: Language): Promise<Summary> {
    if (lines.length === 0) return { overview: NOTHING_YET[language], events: [] };
    const events = await Promise.all(chunk(lines, LINES_PER_EVENT).map((stretch) => this.event(stretch, language, 'user')));
    const { overview, openIssue, title } = await this.ai.json(
      summaryOverview({ events: events.slice(-MAX_OVERVIEW_EVENTS), language }),
      'user',
    );
    return { overview, events, openIssue: openIssue || undefined, title };
  }

  /** Writes a finished stretch's event in the background, so the summary is quick later. */
  prepare(stretch: Line[], language: Language): void {
    void this.event(stretch, language, 'card').catch(() => undefined);
  }

  clear(): void {
    this.events.clear();
  }

  private event(stretch: Line[], language: Language, priority: Priority): Promise<SummaryEvent> {
    const first = stretch[0];
    if (!first) return Promise.reject(new Error('empty stretch'));
    const key = `${language}:${first.id}:${stretch.length}`;
    const known = this.events.get(key);
    if (known) return known;
    const job = this.ai
      .json(summaryEvent({ lines: stretch.map((line) => line.text), language }), priority)
      .then(({ title, detail }): SummaryEvent => ({ t: first.t, title, detail, sources: [longest(stretch).id] }));
    if (stretch.length === LINES_PER_EVENT) {
      this.events.set(key, job);
      job.catch(() => this.events.delete(key));
    }
    return job;
  }
}

function longest(lines: Line[]): Line {
  return lines.reduce((a, b) => (b.text.length > a.text.length ? b : a));
}

/** `count` consecutive parts of near-equal size. */
function split<T>(items: T[], count: number): T[][] {
  return Array.from({ length: count }, (_, i) =>
    items.slice(Math.round((i * items.length) / count), Math.round(((i + 1) * items.length) / count)),
  );
}

/** Consecutive pieces of `size`; the last may be shorter. */
function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}
