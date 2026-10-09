/**
 * Validates every example payload against the contract.
 *
 *   examples/server/<type>.json  must be a valid ServerMessage of that type
 *   examples/client/<type>.json  must be a valid ClientMessage of that type
 *
 * It also fails if a message type has no example, so the examples stay a
 * complete reference for the backend.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientMessageSchema, ServerMessageSchema, parseClientMessage, parseServerMessage } from '../src/index';

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

const sides = [
  { name: 'server', parse: parseServerMessage, types: [...ServerMessageSchema.optionsMap.keys()] },
  { name: 'client', parse: parseClientMessage, types: [...ClientMessageSchema.optionsMap.keys()] },
] as const;

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  ✗ ${msg}`);
};

for (const side of sides) {
  console.log(`${side.name} examples`);
  const dir = join(examplesDir, side.name);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const seen = new Set<string>();

  for (const file of files) {
    const expectedType = file.replace(/\.json$/, '');
    const result = side.parse(readFileSync(join(dir, file), 'utf8'));
    if (!result.ok) {
      fail(`${file}: ${result.error}`);
    } else if (result.message.type !== expectedType) {
      fail(`${file}: type is "${result.message.type}", expected "${expectedType}"`);
    } else {
      seen.add(expectedType);
      console.log(`  ✓ ${file}`);
    }
  }

  for (const type of side.types) {
    if (typeof type === 'string' && !seen.has(type)) fail(`missing example for "${type}"`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} problem(s) found.`);
  process.exit(1);
}
console.log('\nAll examples match the contract.');
