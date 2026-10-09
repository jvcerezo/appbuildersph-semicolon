import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Language } from '@linaw/contract';

/**
 * Background the AI should know about the hearing: how this kind of proceeding works, and the facts of
 * the case (who is on trial, the charges). Only background: what happened still comes from the transcript.
 * Files live in backend/briefs/; CASE_BRIEF lists which ones to use, e.g. "impeachment-trial,day-3".
 */
const BriefSchema = z.object({
  title: z.string().min(3),
  /** Where the facts come from, so someone can check them before the demo. */
  basis: z.string().min(3),
  context: z.object({
    // Each brief goes into every prompt, inside gemma's 4k-token context: keep it short.
    en: z.string().min(20).max(1200),
    tl: z.string().min(20).max(1200),
  }),
});

export type Brief = z.infer<typeof BriefSchema>;

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'briefs');
/** Placeholders left in a copied example would mislead the model, so refuse them. */
const PLACEHOLDER = /\[[^\]]+\]/;

export function loadBriefs(names: readonly string[]): Brief[] {
  return names.map((name) => {
    if (!/^[\w-]+$/.test(name)) throw new Error(`CASE_BRIEF: "${name}" is not a brief name (letters, digits, - and _ only).`);
    const file = join(DIR, `${name}.json`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`CASE_BRIEF: can't read backend/briefs/${name}.json (${err instanceof Error ? err.message : String(err)}).`);
    }
    const result = BriefSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`CASE_BRIEF: backend/briefs/${name}.json is not a valid brief (${issues}).`);
    }
    if (PLACEHOLDER.test(result.data.context.en) || PLACEHOLDER.test(result.data.context.tl)) {
      throw new Error(`CASE_BRIEF: backend/briefs/${name}.json still has [placeholders]. Fill them in first.`);
    }
    return result.data;
  });
}

/** All briefs as one paragraph for the prompts, or "" when there are none. */
export function briefContext(briefs: readonly Brief[], language: Language): string {
  return briefs.map((brief) => brief.context[language]).join(' ');
}
