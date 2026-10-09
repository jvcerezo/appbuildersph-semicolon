/**
 * Writes the contract as JSON Schema (draft 2020-12) to schema/linaw-contract.schema.json,
 * so backends in any language can validate messages or generate types from it.
 *
 *   pnpm --filter @linaw/contract schema          regenerate
 *   pnpm --filter @linaw/contract schema --check  fail if the file is out of date (CI)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  CardSchema,
  ClientMessageSchema,
  CONTRACT_VERSION,
  DEFAULT_PORT,
  PreferencesSchema,
  ServerMessageSchema,
  StatusSchema,
} from '../src/index';

const outFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'linaw-contract.schema.json');

const definitions = {
  ServerMessage: ServerMessageSchema,
  ClientMessage: ClientMessageSchema,
  Card: CardSchema,
  Preferences: PreferencesSchema,
  Status: StatusSchema,
};

// Each definition is fully inlined (no internal $refs), which every codegen tool handles.
const $defs = Object.fromEntries(
  Object.entries(definitions).map(([name, zodSchema]) => {
    const { $schema: _drop, ...json } = zodToJsonSchema(zodSchema, {
      target: 'jsonSchema2019-09',
      $refStrategy: 'none',
    }) as Record<string, unknown>;
    return [name, json];
  }),
);

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `https://linaw.local/contract/v${CONTRACT_VERSION}.schema.json`,
  title: `Linaw contract v${CONTRACT_VERSION}`,
  description:
    `Messages between the Linaw UI and its local backend on ws://localhost:${DEFAULT_PORT}. ` +
    'Generated from packages/contract/src/index.ts — do not edit by hand. ' +
    'Validate backend -> UI messages against $defs/ServerMessage and UI -> backend messages against $defs/ClientMessage.',
  'x-contract-version': CONTRACT_VERSION,
  'x-default-port': DEFAULT_PORT,
  $defs,
};

const text = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(outFile, 'utf8');
  } catch {
    // missing file counts as stale
  }
  if (current.replace(/\r\n/g, '\n') !== text) {
    console.error('✗ schema/linaw-contract.schema.json is out of date. Run: pnpm --filter @linaw/contract schema');
    process.exit(1);
  }
  console.log('✓ JSON Schema is up to date');
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, text);
  console.log(`wrote ${outFile}`);
}
