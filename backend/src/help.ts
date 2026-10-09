import type { Language } from '@linaw/contract';
import type { OllamaClient } from './llm/ollama';
import { whatSaid } from './llm/prompts';
import type { Line } from './session';

const NOTHING_SAID: Record<Language, string> = {
  tl: 'Walang narinig na nagsalita sa nakaraang ilang minuto.',
  en: 'No one was heard speaking in the last few minutes.',
};

// Each point is one AI call (~2 s), so three keeps the wait near 6 s.
const MAX_POINTS = 3;
const LINES_PER_POINT = 4;

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
  const points = answers.map((answer) => answer.point);
  const sources = parts.map((part) => part.reduce((a, b) => (b.text.length > a.text.length ? b : a)).id);
  return { points, sources };
}

/** `count` consecutive parts of near-equal size. */
function split<T>(items: T[], count: number): T[][] {
  return Array.from({ length: count }, (_, i) =>
    items.slice(Math.round((i * items.length) / count), Math.round(((i + 1) * items.length) / count)),
  );
}
