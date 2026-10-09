/** Term finder samples: misheard terms must be found, look-alike words must not. Part of `pnpm validate`. */
import { loadGlossary, phrasesOf } from '../src/terms/glossary';
import { TermFinder } from '../src/terms/finder';

const SAMPLES: [line: string, expected: string[]][] = [
  ['The prosecution will now present the articles of impeachment.', ['articles of impeachment']],
  ['We will now read the article of impeachments.', ['article of impeachments']],
  ['The presiding officers recognized counsel.', ['presiding officers']],
  ['A supoena was served on the witness.', ['supoena']],
  ['Objection, Mr. President.', ['Objection']],
  ['The court is adjourned sine die.', ['sine die']],
  ['The objective of this hearing is clear.', []],
  ['That is not the subject of this inquiry.', []],
  ['The senator is presiding today.', []],
  ['I object to that statement.', []],
];

const glossary = loadGlossary();
const finder = new TermFinder(glossary.map((entry) => ({ id: entry.id, phrases: phrasesOf(entry) })));

console.log('backend term finder');
let failed = 0;
for (const [line, expected] of SAMPLES) {
  const found = finder.find(line).map((term) => term.text);
  const ok = found.length === expected.length && found.every((text, i) => text === expected[i]);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${line}${ok ? '' : `  (found: ${JSON.stringify(found)}, expected: ${JSON.stringify(expected)})`}`);
}
if (failed > 0) process.exit(1);
