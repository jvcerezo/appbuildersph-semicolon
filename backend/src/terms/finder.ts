export interface FoundTerm {
  entryId: string;
  /** Exactly as written in the line (the contract's `terms[].text`). */
  text: string;
  index: number;
}

interface Pattern {
  entryId: string;
  regex: RegExp;
  /** Lowercase words joined by single spaces, for near matches. */
  normalized: string;
  wordCount: number;
}

interface Word {
  text: string;
  start: number;
  end: number;
}

// Below this many letters only exact matches count: short words have too many look-alikes.
const MIN_FUZZY_LETTERS = 6;

/**
 * Whole words, ignoring case; spaces and hyphens match alike. Longer phrases win ("motion to quash" over "motion").
 * Then near matches for what Whisper mishears ("article of impeachments", "supoena").
 */
export class TermFinder {
  private readonly patterns: Pattern[];

  constructor(entries: readonly { id: string; phrases: readonly string[] }[]) {
    this.patterns = entries
      .flatMap((entry) => entry.phrases.map((phrase) => ({ entryId: entry.id, phrase: phrase.trim() })))
      .filter(({ phrase }) => phrase.length > 0)
      .sort((a, b) => b.phrase.length - a.phrase.length)
      .map(({ entryId, phrase }) => {
        const words = phrase.toLowerCase().split(/[\s-]+/).filter(Boolean);
        return {
          entryId,
          regex: new RegExp(`(?<![\\p{L}\\p{N}])${toPattern(phrase)}(?![\\p{L}\\p{N}])`, 'giu'),
          normalized: words.join(' '),
          wordCount: words.length,
        };
      });
  }

  /** In order of appearance: the UI underlines them in that order. */
  find(line: string): FoundTerm[] {
    const taken: [number, number][] = [];
    const found: FoundTerm[] = [];
    const free = (start: number, end: number) => !taken.some(([s, e]) => start < e && end > s);
    const add = (entryId: string, start: number, end: number) => {
      taken.push([start, end]);
      found.push({ entryId, text: line.slice(start, end), index: start });
    };

    for (const { entryId, regex } of this.patterns) {
      for (const match of line.matchAll(regex)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (free(start, end)) add(entryId, start, end);
      }
    }

    const words = wordsOf(line);
    for (const pattern of this.patterns) {
      const limit = maxEdits(pattern);
      if (limit === 0) continue;
      for (const size of [pattern.wordCount, pattern.wordCount + 1, pattern.wordCount - 1]) {
        if (size < 1) continue;
        for (let i = 0; i + size <= words.length; i++) {
          const window = words.slice(i, i + size);
          const first = window[0];
          const last = window[window.length - 1];
          if (!first || !last || !free(first.start, last.end)) continue;
          const candidate = window.map((word) => word.text.toLowerCase()).join(' ');
          if (candidate[0] !== pattern.normalized[0]) continue;
          if (editDistance(candidate, pattern.normalized, limit) <= limit) add(pattern.entryId, first.start, last.end);
        }
      }
    }
    return found.sort((a, b) => a.index - b.index);
  }
}

/** One-word terms allow a single slip, so "objective" never passes for "objection". */
function maxEdits(pattern: Pattern): number {
  const letters = pattern.normalized.replace(/ /g, '').length;
  if (letters < MIN_FUZZY_LETTERS) return 0;
  if (pattern.wordCount === 1) return 1;
  return Math.min(3, Math.floor(letters / 10) + 1);
}

function wordsOf(line: string): Word[] {
  return [...line.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)].map((match) => {
    const start = match.index ?? 0;
    return { text: match[0], start, end: start + match[0].length };
  });
}

/** Levenshtein distance, giving up once it is past `limit`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

function toPattern(phrase: string): string {
  return phrase
    .split(/[\s-]+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s-]+');
}
