import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CardSchema, ServerMessageSchema } from '@linaw/contract';

const segmentId = z.string().min(1);
/** Content that only becomes available once segment `after` has been said. */
const staged = <T extends z.ZodRawShape>(shape: T) => z.object({ after: segmentId, ...shape });

/**
 * A scripted hearing. The timeline is sent after `session.start`; replies are
 * built from what has been said so far, so a summary early in the demo is
 * short and one at the end covers the whole day. `t` in timeline messages is
 * replaced with the real elapsed time.
 */
export const ScenarioSchema = z.object({
  title: z.string().min(1),
  timeline: z.array(z.object({ at: z.number().nonnegative(), message: ServerMessageSchema })),
  replies: z.object({
    whatSaid: z.array(staged({ points: z.array(z.string().min(1)).min(1), sources: z.array(segmentId) })).min(1),
    summary: z.object({
      overviews: z.array(staged({ text: z.string().min(1) })).min(1),
      /** Included once all of their sources have been said. */
      events: z.array(z.object({ title: z.string().min(1), detail: z.string().min(1), sources: z.array(segmentId).min(1) })),
      /** Shown from `after` until `until` (if set) has been said. */
      openIssues: z.array(staged({ until: segmentId.optional(), text: z.string().min(1) })),
    }),
    answers: z.array(
      z.object({ match: z.array(z.string().min(1)).min(1), text: z.string().min(1), sources: z.array(segmentId) }),
    ),
    fallbackAnswer: z.string().min(1),
  }),
  /** Simpler rewrites by card id, returned for `card.simplify`. */
  simplified: z.record(CardSchema.pick({ meaning: true, example: true }).partial()),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const scenariosDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');

export function listScenarios(): string[] {
  return readdirSync(scenariosDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

export function loadScenario(name: string): Scenario {
  return ScenarioSchema.parse(JSON.parse(readFileSync(join(scenariosDir, `${name}.json`), 'utf8')));
}

/** Cross-checks that ids used in replies exist in the timeline. Returns problems found. */
export function lintScenario(scenario: Scenario): string[] {
  const segments = new Set<string>();
  const cards = new Set<string>();
  for (const { message } of scenario.timeline) {
    if (message.type === 'transcript.segment') segments.add(message.id);
    if (message.type === 'card') cards.add(message.card.id);
  }
  const problems: string[] = [];
  const checkSegment = (where: string, id: string) => {
    if (!segments.has(id)) problems.push(`${where}: unknown segment "${id}"`);
  };
  const { whatSaid, summary, answers } = scenario.replies;
  whatSaid.forEach((s, i) => [s.after, ...s.sources].forEach((id) => checkSegment(`whatSaid[${i}]`, id)));
  summary.overviews.forEach((s, i) => checkSegment(`summary.overviews[${i}]`, s.after));
  summary.openIssues.forEach((s, i) => [s.after, ...(s.until ? [s.until] : [])].forEach((id) => checkSegment(`summary.openIssues[${i}]`, id)));
  summary.events.forEach((e, i) => e.sources.forEach((id) => checkSegment(`summary.events[${i}]`, id)));
  answers.forEach((a, i) => a.sources.forEach((id) => checkSegment(`answers[${i}]`, id)));
  for (const id of Object.keys(scenario.simplified)) {
    if (!cards.has(id)) problems.push(`simplified: unknown card "${id}"`);
  }
  return problems;
}
