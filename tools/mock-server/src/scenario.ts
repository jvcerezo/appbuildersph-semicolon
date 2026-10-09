import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CardSchema,
  ServerMessageSchema,
  SummaryEventSchema,
} from '@linaw/contract';

/**
 * A scenario is a scripted hearing: server messages to send at fixed offsets
 * after `session.start`, plus canned replies to the UI's requests. Any `t`
 * field in a timeline message is overwritten with the real elapsed time.
 */
export const ScenarioSchema = z.object({
  title: z.string().min(1),
  timeline: z.array(
    z.object({
      /** Seconds after `session.start` (before `--speed` is applied). */
      at: z.number().nonnegative(),
      message: ServerMessageSchema,
    }),
  ),
  replies: z.object({
    whatSaid: z.array(z.string().min(1)).min(1),
    summary: z.object({
      overview: z.string().min(1),
      events: z.array(SummaryEventSchema),
      openIssue: z.string().optional(),
    }),
    answers: z.array(z.object({ match: z.string().min(1), text: z.string().min(1) })),
    fallbackAnswer: z.string().min(1),
  }),
  /** Simpler rewrites of cards, by card id, returned for `card.simplify`. */
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
  const raw = JSON.parse(readFileSync(join(scenariosDir, `${name}.json`), 'utf8'));
  return ScenarioSchema.parse(raw);
}
