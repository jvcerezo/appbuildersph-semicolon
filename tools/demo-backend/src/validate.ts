import { ZodError } from 'zod';
import { lintScenario, listScenarios, loadScenario } from './scenario';

let failures = 0;
console.log('demo scenarios');

for (const name of listScenarios()) {
  try {
    const scenario = loadScenario(name);
    const problems = lintScenario(scenario);
    if (problems.length > 0) throw new Error(problems.join('; '));
    console.log(`  ✓ ${name}.json (${scenario.timeline.length} events)`);
  } catch (err) {
    failures++;
    const detail =
      err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(err);
    console.error(`  ✗ ${name}.json: ${detail}`);
  }
}

if (failures > 0) process.exit(1);
