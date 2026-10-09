/**
 * Builds backend/law/passages.json: Philippine laws and rules split into short, cited passages
 * that Ask (and later the cards) can look up offline. Needs the internet only when you run it.
 *
 *   pnpm --filter @linaw/backend build-law
 *
 * The texts are Philippine government works, which have no copyright (IP Code, Sec. 176).
 * We take them from LawPhil because the Official Gazette blocks scripts. Check new sources
 * against the official text before adding them, and record which version you used.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LawPassage, LawSource } from '../src/law/library';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'law', 'passages.json');
/** Long sections are cut into pieces of about this size, so a few fit in the model's 4k context. */
const PIECE_CHARS = 900;

interface Section {
  /** Citation parts after the source name, e.g. "Art. XI, Sec. 3". */
  where: string;
  whereTl: string;
  heading: string;
  text: string;
}

interface SourceDef extends LawSource {
  split: (text: string) => Section[];
}

const SOURCES: SourceDef[] = [
  {
    id: 'const',
    title: '1987 Constitution of the Philippines',
    short: '1987 Constitution',
    shortTl: 'Saligang Batas 1987',
    url: 'https://lawphil.net/consti/cons1987.html',
    version: 'As ratified on February 2, 1987',
    split: splitConstitution,
  },
  {
    id: 'evidence',
    title: 'Revised Rules on Evidence (Rules of Court, Rules 128-134), as amended by A.M. No. 19-08-15-SC',
    short: 'Rules on Evidence',
    shortTl: 'Rules on Evidence',
    url: 'https://lawphil.net/courts/rules/am_19-08-15-sc_2019.html',
    version: '2019 amendments, in force since May 1, 2020',
    split: (text) => splitRules(text, 128, 134),
  },
  {
    id: 'civpro-subpoena',
    title: 'Rules of Court, Rule 21: Subpoena',
    short: 'Rules of Court',
    shortTl: 'Rules of Court',
    url: 'https://lawphil.net/courts/rules/rc_1-71_civil.html',
    version: '1997 Rules of Civil Procedure',
    split: (text) => splitRules(text, 21, 21),
  },
  {
    id: 'senate-impeachment',
    title: 'Senate Rules of Procedure on Impeachment Trials (Senate Resolution No. 39, 15th Congress)',
    short: 'Senate Impeachment Rules',
    shortTl: 'Senate Impeachment Rules',
    url: 'https://lawphil.net/congress/senate/r_39_2011.html',
    version: '2011 rules. The Senate may have revised them since (e.g. Resolution No. 1013, 2019); check before relying on numbering',
    split: splitRomanRules,
  },
  {
    id: 'ra3019',
    title: 'Republic Act No. 3019: Anti-Graft and Corrupt Practices Act',
    short: 'RA 3019 (Anti-Graft Act)',
    shortTl: 'RA 3019 (Anti-Graft Act)',
    url: 'https://lawphil.net/statutes/repacts/ra1960/ra_3019_1960.html',
    version: 'As enacted in 1960, with amendments shown on LawPhil',
    split: splitStatute,
  },
  {
    id: 'ra6713',
    title: 'Republic Act No. 6713: Code of Conduct and Ethical Standards for Public Officials and Employees',
    short: 'RA 6713 (Code of Conduct)',
    shortTl: 'RA 6713 (Code of Conduct)',
    url: 'https://lawphil.net/statutes/repacts/ra1989/ra_6713_1989.html',
    version: 'As enacted in 1989',
    split: splitStatute,
  },
];

const passages: LawPassage[] = [];
const sources: LawSource[] = [];
for (const { split, ...source } of SOURCES) {
  const text = toText(await download(source.url));
  const sections = split(text);
  if (sections.length === 0) throw new Error(`${source.id}: no sections found; the page layout may have changed`);
  sources.push(source);
  for (const section of sections) {
    const pieces = cut(section.text, PIECE_CHARS);
    pieces.forEach((piece, i) => {
      passages.push({
        id: `${source.id}:${section.where.replace(/[^\w]+/g, '-').toLowerCase()}${pieces.length > 1 ? `:${i + 1}` : ''}`,
        source: source.id,
        cite: `${source.short}, ${section.where}`,
        citeTl: `${source.shortTl}, ${section.whereTl}`,
        heading: section.heading,
        text: piece,
      });
    });
  }
  console.log(`${source.id}: ${sections.length} sections`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), sources, passages }, null, 1)}\n`);
console.log(`Wrote ${passages.length} passages to ${OUT}`);

// ------------------------------------------------------------------ fetching

async function download(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Linaw law library builder)' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  // LawPhil pages are Windows-1252.
  return new TextDecoder('windows-1252').decode(await res.arrayBuffer());
}

function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/h\d>|<\/tr>|<\/li>|<\/blockquote>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&[lr]squo;/g, '’')
    .replace(/&[lr]dquo;/g, '"')
    .replace(/&mdash;|&ndash;/g, '-')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

// ------------------------------------------------------------------ splitting

/** "ARTICLE XI" / title line / "Section 3. ..." */
function splitConstitution(text: string): Section[] {
  const sections: Section[] = [];
  let article = '';
  let articleTitle = '';
  let current: Section | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const art = /^ARTICLE ([IVXL]+)$/.exec(line);
    if (art?.[1]) {
      article = art[1];
      articleTitle = titleCase(lines[i + 1] ?? '');
      i++;
      current = null;
      continue;
    }
    if (!article) continue;
    const sec = /^Section (\d+)\.\s*(.*)$/.exec(line);
    if (sec?.[1]) {
      current = { where: `Art. ${article}, Sec. ${sec[1]}`, whereTl: `Art. ${article}, Sek. ${sec[1]}`, heading: articleTitle, text: sec[2] ?? '' };
      sections.push(current);
    } else if (current && !/^(The LawPhil|Back to|Constitutions)/.test(line)) {
      current.text += `\n${line}`;
    }
  }
  return sections.filter((s) => s.text.trim().length > 20);
}

/** "RULE 130" / title / "Section 37. Hearsay. - ..." for rules `from` to `to`. */
function splitRules(text: string, from: number, to: number): Section[] {
  const sections: Section[] = [];
  let rule = 0;
  let ruleTitle = '';
  let current: Section | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const head = /^RULE (\d+)$/.exec(line);
    if (head?.[1]) {
      rule = Number(head[1]);
      ruleTitle = lines[i + 1] ?? '';
      i++;
      current = null;
      continue;
    }
    if (rule < from || rule > to) continue;
    const sec = /^Section (\d+)\.\s*(.*)$/.exec(line);
    if (sec?.[1]) {
      const body = sec[2] ?? '';
      const named = /^([^.]{3,90})\.\s*-?\s*(.*)$/.exec(body);
      current = {
        where: `Rule ${rule}, Sec. ${sec[1]}`,
        whereTl: `Rule ${rule}, Sek. ${sec[1]}`,
        heading: named?.[1] ? `${ruleTitle}: ${named[1]}` : ruleTitle,
        text: body,
      };
      sections.push(current);
    } else if (current && !isSubheading(line, lines[i + 1])) {
      current.text += `\n${line}`;
    }
  }
  return sections;
}

/** "XIV. All motions, objections, ..." */
function splitRomanRules(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of text.split('\n')) {
    const rule = /^([IVXL]+)\.\s+(.*)$/.exec(line);
    if (rule?.[1]) {
      current = { where: `Rule ${rule[1]}`, whereTl: `Rule ${rule[1]}`, heading: 'Impeachment trial procedure', text: rule[2] ?? '' };
      sections.push(current);
    } else if (current && !/^(Adopted|Approved|The LawPhil|Back to)/i.test(line)) {
      current.text += `\n${line}`;
    }
  }
  return sections;
}

/** "Section 3. Corrupt practices of public officers. ..." */
function splitStatute(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of text.split('\n')) {
    const sec = /^Sec(?:tion)?\.? (\d+)\.\s*(.*)$/.exec(line);
    if (sec?.[1]) {
      const body = sec[2] ?? '';
      const named = /^([^.]{3,90})\.\s*-?\s*(.*)$/.exec(body);
      current = { where: `Sec. ${sec[1]}`, whereTl: `Sek. ${sec[1]}`, heading: named?.[1] ?? '', text: body };
      sections.push(current);
    } else if (current && !/^(Approved|The LawPhil|Back to)/i.test(line)) {
      current.text += `\n${line}`;
    }
  }
  return sections.filter((s) => s.text.trim().length > 20);
}

/** A short title line right before the next section, e.g. "Hearsay". */
function isSubheading(line: string, next: string | undefined): boolean {
  return line.length < 70 && !/[.;:,]$/.test(line) && /^Section \d+\./.test(next ?? '');
}

function titleCase(line: string): string {
  return line.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Cuts at line breaks, then sentence ends, so each piece stands on its own. */
function cut(text: string, max: number): string[] {
  const clean = text.trim();
  if (clean.length <= max) return [clean];
  const pieces: string[] = [];
  let piece = '';
  for (const part of clean.split(/(?<=\n)|(?<=[.;]) (?=[A-Z(])/)) {
    if (piece && piece.length + part.length > max) {
      pieces.push(piece.trim());
      piece = '';
    }
    piece += part.endsWith('\n') ? part : `${part} `;
  }
  if (piece.trim()) pieces.push(piece.trim());
  return pieces;
}
