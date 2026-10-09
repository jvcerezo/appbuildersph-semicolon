/** Checks backend/glossary/terms.json; part of `pnpm validate`, so CI catches a broken glossary. */
import { loadDrafts, loadGlossary, loadWatchlist } from '../src/terms/glossary';

console.log('backend glossary');
try {
  const terms = loadGlossary();
  console.log(`  ✓ terms.json (${terms.length} terms)`);
  const watched = loadWatchlist(terms);
  console.log(`  ✓ watchlist.json (${watched.length} terms)`);
  const drafts = loadDrafts(watched);
  console.log(`  ✓ drafts.json (${drafts.length} of ${watched.length} watch-list terms drafted)`);
} catch (err) {
  console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
