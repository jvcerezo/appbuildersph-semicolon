/** Term finder samples: misheard terms must be found, look-alike words must not. Part of `pnpm validate`. */
import { loadGlossary, loadWatchlist, phrasesOf } from '../src/terms/glossary';
import { TermFinder } from '../src/terms/finder';

const SAMPLES: [line: string, expected: string[]][] = [
  ['The prosecution will now present the articles of impeachment.', ['prosecution', 'articles of impeachment']],
  ['We will now read the article of impeachments.', ['article of impeachments']],
  ['The presiding officers recognized counsel.', ['presiding officers']],
  ['A supoena was served on the witness.', ['supoena']],
  ['Objection, Mr. President.', ['Objection']],
  ['The court is adjourned sine die.', ['adjourned', 'sine die']],
  ['The objective of this hearing is clear.', []],
  ['That is not the subject of this inquiry.', []],
  ['The senator is presiding today.', []],
  ['I object to that statement.', []],
  ['Objection, hearsay.', ['Objection', 'hearsay']],
  ['We served a subpoena duces tecum on the custodian.', ['subpoena duces tecum']],
  ['The defense moves to quash that subpoena.', ['moves to quash', 'subpoena']],
  ['She remains under oath.', ['under oath']],
];

const glossary = loadGlossary();
const entries = [...glossary, ...loadWatchlist(glossary)];
const finder = new TermFinder(entries.map((entry) => ({ id: entry.id, phrases: phrasesOf(entry) })));

console.log('backend term finder');
let failed = 0;
for (const [line, expected] of SAMPLES) {
  const found = finder.find(line).map((term) => term.text);
  const ok = found.length === expected.length && found.every((text, i) => text === expected[i]);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${line}${ok ? '' : `  (found: ${JSON.stringify(found)}, expected: ${JSON.stringify(expected)})`}`);
}
if (failed > 0) process.exit(1);
