export interface FoundTerm {
  entryId: string;
  /** Exactly as written in the line (the contract's `terms[].text`). */
  text: string;
  index: number;
}

interface Pattern {
  entryId: string;
  regex: RegExp;
}

/** Whole words, ignoring case; spaces and hyphens match alike. Longer phrases win ("motion to quash" over "motion"). */
export class TermFinder {
  private readonly patterns: Pattern[];

  constructor(entries: readonly { id: string; phrases: readonly string[] }[]) {
    this.patterns = entries
      .flatMap((entry) => entry.phrases.map((phrase) => ({ entryId: entry.id, phrase: phrase.trim() })))
      .filter(({ phrase }) => phrase.length > 0)
      .sort((a, b) => b.phrase.length - a.phrase.length)
      .map(({ entryId, phrase }) => ({
        entryId,
        regex: new RegExp(`(?<![\\p{L}\\p{N}])${toPattern(phrase)}(?![\\p{L}\\p{N}])`, 'giu'),
      }));
  }

  /** In order of appearance: the UI underlines them in that order. */
  find(line: string): FoundTerm[] {
    const taken: [number, number][] = [];
    const found: FoundTerm[] = [];
    for (const { entryId, regex } of this.patterns) {
      for (const match of line.matchAll(regex)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (taken.some(([s, e]) => start < e && end > s)) continue;
        taken.push([start, end]);
        found.push({ entryId, text: match[0], index: start });
      }
    }
    return found.sort((a, b) => a.index - b.index);
  }
}

function toPattern(phrase: string): string {
  return phrase
    .split(/[\s-]+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s-]+');
}
