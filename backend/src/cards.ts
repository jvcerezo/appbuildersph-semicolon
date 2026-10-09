import type { Card, Language, Preferences } from '@linaw/contract';
import type { OllamaClient } from './llm/ollama';
import { rightNow, simpler } from './llm/prompts';
import type { GlossaryEntry } from './terms/glossary';

const FALLBACK_NOW: Record<Language, string> = {
  tl: 'Nabanggit ito ngayon sa pagdinig.',
  en: 'This was just mentioned in the hearing.',
};

export interface CardResult {
  card: Card;
  aiError?: unknown;
}

/** Meaning and example from the glossary, "Right now" from the AI. Never fails: without the AI it uses a plain line. */
export async function checkedCard(args: {
  id: string;
  t: number;
  entry: GlossaryEntry;
  before: string[];
  line: string;
  preferences: Preferences;
  ai: OllamaClient;
}): Promise<CardResult> {
  const { entry } = args;
  // With no English entry the whole card stays in Tagalog, so `language` describes all of it.
  const english = args.preferences.language === 'en' ? entry.en : undefined;
  const language: Language = english ? 'en' : 'tl';
  const text = english ?? entry.tl;

  let now = FALLBACK_NOW[language];
  let aiError: unknown;
  try {
    ({ now } = await args.ai.json(rightNow({ term: entry.term, meaning: text.meaning, before: args.before, line: args.line, language }), 'card'));
  } catch (err) {
    aiError = err;
  }
  return {
    card: { id: args.id, term: entry.term, kind: 'checked', meaning: text.meaning, example: text.example, now, t: args.t, language },
    aiError,
  };
}

/** The same card in easier words. The AI rewrote it, so it is no longer Checked. */
export async function simplerCard(card: Card, ai: OllamaClient): Promise<Card> {
  const { meaning, example } = await ai.json(
    simpler({ term: card.term, meaning: card.meaning, example: card.example, language: card.language }),
    'user',
  );
  return { ...card, kind: 'ai', meaning, example };
}
