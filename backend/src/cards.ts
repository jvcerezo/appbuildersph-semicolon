import type { Card, Language, Preferences } from '@linaw/contract';
import { asContext, basisFor, type Grounding } from './grounding';
import type { OllamaClient } from './llm/ollama';
import { aiCard as aiCardPrompt, rightNow, simpler } from './llm/prompts';
import type { DraftEntry, GlossaryEntry } from './terms/glossary';

const FALLBACK_NOW: Record<Language, string> = {
  tl: 'Nabanggit ito ngayon sa pagdinig.',
  en: 'This was just mentioned in the hearing.',
};

/** Meaning and example from the glossary, ready at once. A plain "Right now" line stands in until the AI writes one. */
export function checkedCard(args: { id: string; t: number; entry: GlossaryEntry; preferences: Preferences }): Card {
  const { entry } = args;
  // With no English entry the whole card stays in Tagalog, so `language` describes all of it.
  const english = args.preferences.language === 'en' ? entry.en : undefined;
  const language: Language = english ? 'en' : 'tl';
  const text = english ?? entry.tl;
  return {
    id: args.id,
    term: entry.term,
    kind: 'checked',
    meaning: text.meaning,
    example: text.example,
    now: FALLBACK_NOW[language],
    t: args.t,
    language,
    ...(entry.basis ? { basis: entry.basis } : {}),
  };
}

/** A watch-list term the AI explained ahead of time (D14): ready at once like a Checked card, but still AI-explained. */
export function draftCard(args: { id: string; t: number; entry: DraftEntry; preferences: Preferences }): Card {
  const { language, level } = args.preferences;
  const text = args.entry[language][level];
  return {
    id: args.id,
    term: args.entry.term,
    kind: 'ai',
    meaning: text.meaning,
    example: text.example,
    now: FALLBACK_NOW[language],
    t: args.t,
    language,
    ...(args.entry.basis ? { basis: args.entry.basis } : {}),
  };
}

/** A card the AI wrote whole, and whether the AI thinks the term is jargon at all. */
export async function aiCard(args: {
  id: string;
  term: string;
  t: number;
  before: string[];
  line: string;
  preferences: Preferences;
  ai: OllamaClient;
  /** Law passages, glossary meanings and case brief for the term (grounding.ts). */
  grounding: Grounding;
}): Promise<{ card: Card; jargon: boolean }> {
  const { language, level } = args.preferences;
  const g = args.grounding;
  const text = await args.ai.json(
    aiCardPrompt({ term: args.term, before: args.before, line: args.line, language, level, laws: g.laws, context: asContext({ ...g, laws: [] }, language) }),
    'card',
  );
  // The English legal meaning is the best match for the (English) law text.
  const basis = basisFor(`${text.english} ${text.meaning}`, g, args.term);
  return {
    card: { id: args.id, term: args.term, kind: 'ai', meaning: text.meaning, example: text.example, now: text.now, t: args.t, language, ...(basis ? { basis } : {}) },
    jargon: text.jargon,
  };
}

/** What the term means at this moment of the hearing. */
export async function nowLine(card: Card, before: string[], line: string, ai: OllamaClient, context = ''): Promise<string> {
  const { now } = await ai.json(
    rightNow({ term: card.term, meaning: card.meaning, before, line, language: card.language, context }),
    'background',
  );
  return now;
}

/** The card's meaning and example in easier words. The AI rewrote them, so the card is no longer Checked. */
export function simplerText(card: Card, ai: OllamaClient): Promise<Pick<Card, 'meaning' | 'example'>> {
  return ai.json(simpler({ term: card.term, meaning: card.meaning, example: card.example, language: card.language }), 'user');
}
