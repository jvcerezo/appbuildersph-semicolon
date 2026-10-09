/**
 * Writes AI drafts for every watch-list term into glossary/drafts.json (D14), so their cards
 * show at once instead of after 5–30 s of live AI. Terms that already have a draft are kept.
 *
 *   pnpm --filter @linaw/backend draft-cards [--all]
 *
 * --all rewrites every draft. Needs Ollama running.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { ExplanationLevel, Language } from '@linaw/contract';
import { loadConfig } from '../src/config';
import { OllamaClient } from '../src/llm/ollama';
import { aiCard } from '../src/llm/prompts';
import { DRAFTS_FILE, loadDrafts, loadGlossary, loadWatchlist, type DraftEntry, type WatchEntry } from '../src/terms/glossary';

const { values } = parseArgs({ options: { all: { type: 'boolean', default: false } } });
try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

const config = loadConfig();
const ai = new OllamaClient(config.ollamaUrl, config.ollamaModel);
const watchlist = loadWatchlist(loadGlossary());
const kept = values.all ? [] : loadDrafts(watchlist);
const drafts = new Map(kept.map((draft) => [draft.id, draft]));
const todo = watchlist.filter((entry) => !drafts.has(entry.id));

console.log(`${todo.length} of ${watchlist.length} watch-list terms to draft with ${ai.model}`);
await ai.warmUp();

/** The prompt explains a term in a sentence; a neutral one keeps the meaning general. */
const line = (term: string, language: Language): string =>
  language === 'tl' ? `Nabanggit ang "${term}" sa isang pagdinig sa Senado.` : `"${term}" was said in a Senate hearing.`;

async function text(entry: WatchEntry, language: Language, level: ExplanationLevel): Promise<{ meaning: string; example: string }> {
  const card = await ai.json(aiCard({ term: entry.term, before: [], line: line(entry.term, language), language, level }), 'card');
  return { meaning: card.meaning, example: card.example };
}

function save(): void {
  const ordered = watchlist.flatMap((entry) => drafts.get(entry.id) ?? []);
  writeFileSync(DRAFTS_FILE, `${JSON.stringify({ drafts: ordered }, null, 2)}\n`);
}

let failed = 0;
for (const [i, entry] of todo.entries()) {
  const startedAt = Date.now();
  try {
    const draft: DraftEntry = {
      id: entry.id,
      term: entry.term,
      tl: { simple: await text(entry, 'tl', 'simple'), detailed: await text(entry, 'tl', 'detailed') },
      en: { simple: await text(entry, 'en', 'simple'), detailed: await text(entry, 'en', 'detailed') },
      source: `AI draft (${ai.model}), not checked`,
    };
    drafts.set(entry.id, draft);
    save();
    console.log(`  ✓ ${i + 1}/${todo.length} ${entry.term} (${((Date.now() - startedAt) / 1000).toFixed(1)} s): ${draft.tl.simple.meaning}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${entry.term}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`${drafts.size} drafts in ${DRAFTS_FILE}${failed > 0 ? `; ${failed} failed, run again to retry them` : ''}`);
process.exit(failed > 0 ? 1 : 0);
