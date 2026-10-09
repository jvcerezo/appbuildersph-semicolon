import { ZodError } from 'zod';
import { listScenarios, loadScenario } from './scenario';

let failures = 0;
console.log('mock scenarios');

for (const name of listScenarios()) {
  try {
    const scenario = loadScenario(name);
    const cardIds = new Set(
      scenario.timeline.flatMap(({ message }) => (message.type === 'card' ? [message.card.id] : [])),
    );
    for (const id of Object.keys(scenario.simplified)) {
      if (!cardIds.has(id)) throw new Error(`simplified["${id}"] has no matching card in the timeline`);
    }
    console.log(`  ✓ ${name}.json (${scenario.timeline.length} events)`);
  } catch (err) {
    failures++;
    const detail =
      err instanceof ZodError
        ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : String(err);
    console.error(`  ✗ ${name}.json: ${detail}`);
  }
}

if (failures > 0) process.exit(1);
