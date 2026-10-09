import type { Language } from '@linaw/contract';
import type { OllamaClient } from './llm/ollama';
import { translateLine } from './llm/prompts';

/** Common Tagalog words; English hearing lines have almost none of them. */
const TAGALOG_WORDS = new Set(
  'ang ng mga sa na ay si ni kay po ho ito iyan iyon hindi siya sila kami tayo ako ka mo ko niya nila natin namin ninyo kung para pero dahil kasi lang din rin pa naman ba yung yun dito diyan doon wala may mayroon opo'.split(' '),
);

/** `tl` when at least a fifth of the words are common Tagalog words, else `en`. Good enough for whole lines. */
export function detectLanguage(text: string): Language {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length === 0) return 'en';
  const tagalog = words.filter((word) => TAGALOG_WORDS.has(word)).length;
  return tagalog / words.length >= 0.2 ? 'tl' : 'en';
}

/** Translations waiting beyond this are skipped: a late translation of an old line helps no one. */
const MAX_BACKLOG = 3;

/**
 * Transcript lines into the user's language, on the AI's idle time only (priority `idle`),
 * so cards and questions never wait for a translation.
 */
export class Translator {
  constructor(private readonly ai: OllamaClient) {}

  /**
   * The line in `target`, or null when it is already in `target`, empty, or the AI is busy.
   * `keep` are the legal terms found in the line, kept as said.
   */
  async translate(text: string, target: Language, keep: string[]): Promise<string | null> {
    if (!text.trim() || detectLanguage(text) === target) return null;
    if (this.ai.waitingCount('idle') >= MAX_BACKLOG) return null;
    const { text: translated } = await this.ai.json(translateLine({ line: text, keep, language: target }), 'idle');
    return translated === text ? null : translated;
  }
}
