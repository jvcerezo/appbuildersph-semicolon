import type { Language } from '@linaw/contract';
import { briefContext, type Brief } from './briefs';
import { LawLibrary, spellOutAcronyms, tokens } from './law/library';
import type { TermFinder } from './terms/finder';
import type { GlossaryEntry } from './terms/glossary';

/**
 * Linaw's own knowledge, given to the AI with every request so it explains from our sources rather
 * than from memory: the case brief, the checked glossary, and the law library.
 */
export interface Grounding {
  /** Law passages for the request, citation in the user's language, text clipped to fit the 4k context. */
  laws: { cite: string; text: string }[];
  /** Checked-glossary meanings of the terms the text mentions. */
  meanings: { term: string; meaning: string }[];
  /** The case brief (backend/briefs/). */
  brief: string;
}

export interface GroundingSources {
  law: LawLibrary;
  glossary: ReadonlyMap<string, GlossaryEntry>;
  finder: TermFinder;
  briefs: readonly Brief[];
}

export function ground(
  sources: GroundingSources,
  text: string,
  language: Language,
  { laws = 2, chars = 500, term }: { laws?: number; chars?: number; term?: string } = {},
): Grounding {
  const meanings = sources.finder.find(text).flatMap(({ entryId }) => {
    const entry = sources.glossary.get(entryId);
    if (!entry) return [];
    return [{ term: entry.term, meaning: (language === 'en' ? entry.en : undefined)?.meaning ?? entry.tl.meaning }];
  });
  const query = [spellOutAcronyms(text), ...meanings.map((m) => m.term)].join(' ');
  // A card is about one term: the passages that define it come first, then the ones its sentence brings.
  const hits = laws > 0 ? [...(term ? sources.law.search(spellOutAcronyms(term), laws) : []), ...sources.law.search(query, laws)] : [];
  const seen = new Set<string>();
  const picked = hits.filter(({ passage }) => !seen.has(passage.id) && seen.add(passage.id)).slice(0, laws);
  return {
    laws: picked.map(({ passage }) => ({ cite: language === 'tl' ? passage.citeTl : passage.cite, text: clip(passage.text, chars) })),
    meanings: dedupe(meanings),
    brief: briefContext(sources.briefs, language),
  };
}

/** The grounding as one background paragraph, for prompts that take a single `context`. */
export function asContext(g: Grounding, language: Language): string {
  const tl = language === 'tl';
  const parts = [g.brief];
  if (g.meanings.length > 0) {
    parts.push(`${tl ? 'Mga kahulugan mula sa glossary' : 'Meanings from the glossary'}: ${g.meanings.map((m) => `${m.term}: ${m.meaning}`).join(' | ')}`);
  }
  if (g.laws.length > 0) {
    parts.push(`${tl ? 'Kaugnay na batas' : 'Related law'}: ${g.laws.map((l) => `[${l.cite}] ${l.text}`).join(' | ')}`);
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * The citation for an explanation, never a number the model wrote. With a `term`, only a passage that
 * contains the term itself counts (acronyms spelled out, so "SALN" finds "Statement of Assets…"), and
 * the one the explanation shares most words with wins. Undefined when no passage backs it: a citation
 * that merely shares a few words would mislead.
 */
export function basisFor(explanation: string, g: Grounding, term?: string): string | undefined {
  if (term) {
    const plain = tokens(term);
    // "SALN" -> "SALN (Statement of Assets, Liabilities and Net Worth)": the spelled-out words alone.
    const spelled = tokens(spellOutAcronyms(term.toUpperCase())).filter((w) => !plain.includes(w));
    const contains = (text: string) => {
      const have = new Set(tokens(text));
      return (plain.length > 0 && plain.every((w) => have.has(w))) || (spelled.length > 0 && spelled.every((w) => have.has(w)));
    };
    const containing = g.laws.filter((law) => contains(law.text));
    if (containing.length === 0) return undefined;
    // A section whose heading names the term is that term's own section ("Cross-examination; its purpose…").
    const own = containing.filter((law) => {
      const heading = /^(.{3,80}?)(?:\.\s*[-–]|;|\.\s{2,}|:)/.exec(law.text)?.[1];
      return heading !== undefined && contains(heading);
    });
    const candidates = own.length > 0 ? own : containing;
    const i = LawLibrary.closest(explanation, candidates, 1);
    return (candidates[i] ?? candidates[0])?.cite;
  }
  const i = LawLibrary.closest(explanation, g.laws);
  return i >= 0 ? g.laws[i]?.cite : undefined;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), max * 0.6) + 1).trim()} …`;
}

function dedupe<T extends { term: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.term) && seen.add(item.term));
}
