import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const TextSchema = z.object({
  meaning: z.string().min(1),
  example: z.string().min(1),
});

export const GlossaryEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'use lowercase words joined by "-"'),
  term: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  tl: TextSchema,
  en: TextSchema.optional(),
  source: z.string().optional(),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

export const GlossarySchema = z
  .object({ terms: z.array(GlossaryEntrySchema) })
  .superRefine(({ terms }, ctx) => {
    const ids = new Set<string>();
    const phrases = new Map<string, string>();
    terms.forEach((entry, i) => {
      if (ids.has(entry.id)) ctx.addIssue({ code: 'custom', path: ['terms', i, 'id'], message: `"${entry.id}" is used twice` });
      ids.add(entry.id);
      for (const phrase of phrasesOf(entry)) {
        const key = normalize(phrase);
        const owner = phrases.get(key);
        if (owner !== undefined && owner !== entry.id) {
          ctx.addIssue({ code: 'custom', path: ['terms', i], message: `"${phrase}" also belongs to "${owner}"` });
        }
        phrases.set(key, entry.id);
      }
    });
  });

/** Every entry becomes a Checked card. Format: docs/backend-plan.md. */
export const GLOSSARY_FILE = fileURLToPath(new URL('../../glossary/terms.json', import.meta.url));

export function loadGlossary(file = GLOSSARY_FILE): GlossaryEntry[] {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const result = GlossarySchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`The glossary (${file}) has problems:\n  ${problems}`);
  }
  return result.data.terms;
}

export const WatchEntrySchema = z.object({
  term: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
});
export type WatchEntry = z.infer<typeof WatchEntrySchema> & { id: string };

/** Terms with no checked explanation: the AI explains them (AI-explained cards). Glossary entries win. */
export const WATCHLIST_FILE = fileURLToPath(new URL('../../glossary/watchlist.json', import.meta.url));

export function loadWatchlist(glossary: readonly GlossaryEntry[], file = WATCHLIST_FILE): WatchEntry[] {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const result = z.object({ terms: z.array(WatchEntrySchema) }).safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`The watch list (${file}) has problems:\n  ${problems}`);
  }
  const owners = new Map<string, string>();
  for (const entry of glossary) for (const phrase of phrasesOf(entry)) owners.set(normalize(phrase), `glossary "${entry.id}"`);
  const problems: string[] = [];
  const entries = result.data.terms.map((entry) => {
    const id = `w-${normalize(entry.term).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    for (const phrase of phrasesOf(entry)) {
      const owner = owners.get(normalize(phrase));
      if (owner) problems.push(`"${phrase}" is already in the ${owner}`);
      owners.set(normalize(phrase), `watch list "${entry.term}"`);
    }
    return { ...entry, id };
  });
  if (problems.length > 0) throw new Error(`The watch list (${file}) has problems:\n  ${problems.join('\n  ')}`);
  return entries;
}

export function phrasesOf(entry: Pick<GlossaryEntry, 'term' | 'aliases'>): string[] {
  return [entry.term, ...entry.aliases];
}

function normalize(phrase: string): string {
  return phrase.toLowerCase().split(/[\s-]+/).join(' ').trim();
}
