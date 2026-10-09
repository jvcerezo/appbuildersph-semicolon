/** Checks backend/glossary/terms.json; part of `pnpm validate`, so CI catches a broken glossary. */
import { loadGlossary } from '../src/terms/glossary';

console.log('backend glossary');
try {
  const terms = loadGlossary();
  console.log(`  ✓ terms.json (${terms.length} terms)`);
} catch (err) {
  console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
