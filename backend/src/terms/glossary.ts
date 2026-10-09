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

export function phrasesOf(entry: Pick<GlossaryEntry, 'term' | 'aliases'>): string[] {
  return [entry.term, ...entry.aliases];
}

function normalize(phrase: string): string {
  return phrase.toLowerCase().split(/[\s-]+/).join(' ').trim();
}
