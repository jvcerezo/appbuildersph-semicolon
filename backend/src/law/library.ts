import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where a passage comes from. Built by scripts/build-law.ts. */
export interface LawSource {
  id: string;
  title: string;
  short: string;
  shortTl: string;
  url: string;
  /** Which version of the text this is. */
  version: string;
}

export interface LawPassage {
  id: string;
  source: string;
  /** e.g. "1987 Constitution, Art. XI, Sec. 3" */
  cite: string;
  citeTl: string;
  heading: string;
  text: string;
}

interface LawFile {
  builtAt: string;
  sources: LawSource[];
  passages: LawPassage[];
}

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'law', 'passages.json');

/** Tagalog words in questions, mapped to the English the laws are written in. */
const TAGALOG: Record<string, string> = {
  saligang: 'constitution',
  konstitusyon: 'constitution',
  batas: 'law',
  testigo: 'witness',
  saksi: 'witness',
  ebidensya: 'evidence',
  ebidensiya: 'evidence',
  katibayan: 'evidence',
  patunay: 'evidence proof',
  paratang: 'charge accusation articles',
  akusasyon: 'charge accusation',
  kaso: 'case',
  paglilitis: 'trial',
  nililitis: 'trial',
  litisin: 'trial',
  lilitisin: 'trial',
  namumuno: 'preside presiding officer',
  mamumuno: 'preside presiding officer',
  pinuno: 'preside presiding officer',
  tatanggalin: 'removed removal',
  matanggal: 'removed removal',
  natanggal: 'removed removal',
  ikukulong: 'imprisonment',
  makukulong: 'imprisonment',
  nagsinungaling: 'perjury false',
  kasinungalingan: 'perjury false',
  pagdinig: 'hearing trial',
  hukom: 'judge court',
  hukuman: 'court',
  korte: 'court',
  senado: 'senate',
  senador: 'senator senate',
  kamara: 'house representatives',
  kongreso: 'congress',
  pangulo: 'president',
  bise: 'vice-president',
  ombudsman: 'ombudsman',
  hatol: 'judgment conviction',
  hatulan: 'convicted conviction',
  mahatulan: 'convicted conviction',
  nahatulan: 'convicted conviction',
  hinatulan: 'convicted conviction',
  mapatunayang: 'convicted guilty',
  nagkasala: 'guilty convicted',
  'two-thirds': 'two-thirds',
  boto: 'vote',
  botohan: 'vote',
  sumpa: 'oath',
  panunumpa: 'oath',
  pagtutol: 'objection',
  tutol: 'objection',
  mosyon: 'motion',
  suhol: 'bribery',
  katiwalian: 'graft corruption',
  korapsyon: 'graft corruption',
  kurapsyon: 'graft corruption',
  pagtataksil: 'treason betrayal',
  tiwala: 'trust',
  publiko: 'public',
  opisyal: 'officer official',
  kawani: 'employee',
  ari: 'assets property',
  ariarian: 'assets property',
  'ari-arian': 'assets property',
  yaman: 'assets wealth',
  saln: 'assets liabilities net worth statement',
  tanggalin: 'removed removal',
  tanggal: 'removed removal',
  parusa: 'penalty',
  kulong: 'imprisonment',
  pagkakakulong: 'imprisonment',
  dokumento: 'documents',
  utos: 'order',
  ipatawag: 'subpoena summons',
  patawag: 'subpoena summons',
  sabi: 'statement hearsay',
  narinig: 'hearsay',
  karapatan: 'rights',
  tanong: 'question',
  abogado: 'counsel',
  depensa: 'defense',
  tagausig: 'prosecution prosecutors',
  'taga-usig': 'prosecution prosecutors',
  piskal: 'prosecution',
};

const STOPWORDS = new Set(
  'a an the of to in on for by and or but is are was were be been being it its this that these those as at with from shall may such any all other than not no which who whom when where what how why do does did has have had their there his her him he she they them we you your our upon into such also each said thereof therein hereby within ang ng mga sa na at si ni kay ay ba po ito iyan iyon ano bakit paano saan sino kung para may mayroon wala hindi siya sila kami tayo ko mo niya nila namin natin'.split(
    ' ',
  ),
);

/** Acronyms people say but the laws spell out. */
const ACRONYMS: Record<string, string> = {
  saln: 'Statement of Assets, Liabilities and Net Worth',
  pao: "Public Attorney's Office",
  ra: 'Republic Act',
  cj: 'Chief Justice',
  sc: 'Supreme Court',
};

/** "Ano ang SALN?" becomes "Ano ang SALN (Statement of Assets, Liabilities and Net Worth)?" */
export function spellOutAcronyms(text: string): string {
  return text.replace(/\b[A-Z]{2,5}\b/g, (word) => {
    const full = ACRONYMS[word.toLowerCase()];
    return full ? `${word} (${full})` : word;
  });
}

/** Tagalog affixes on borrowed words: "ma-impeach", "na-convict", "i-subpoena", "nag-object". */
const TAGALOG_PREFIX = /^(?:ma|na|ni|i|mag|nag|pag|pa|ka|maka|naka|ipa|ipag|mai|nai)-(?=[a-z]{3,})/;

/** Lowercase words, light stemming so "witnesses" finds "witness". */
export function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? [];
  const out: string[] = [];
  for (const raw of words) {
    const word = raw.replace(/^-+|-+$/g, '').replace(TAGALOG_PREFIX, '');
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    const english = TAGALOG[word];
    if (english) {
      out.push(...english.split(' ').map(stem));
      continue;
    }
    out.push(stem(word));
  }
  return out;
}

/** Light suffix stripping, applied to questions and laws alike, so "impeached" meets "impeachment". */
function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(sses|shes|ches|xes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 7 && w.endsWith('ment')) w = w.slice(0, -4);
  else if (w.length > 6 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ed') && !w.endsWith('eed')) w = w.slice(0, -2);
  return w;
}

/**
 * Linaw explains impeachment hearings, so on a near tie the impeachment provisions are the likelier
 * answer: "Who can be impeached?" means Art. XI, not how a witness is impeached under the evidence rules.
 */
const FOCUS: [RegExp, number][] = [
  [/^const:art-xi-/, 1.8],
  [/^senate-impeachment:/, 1.4],
  [/^ra(3019|6713):/, 1.15],
];

function focus(id: string): number {
  return FOCUS.find(([pattern]) => pattern.test(id))?.[1] ?? 1;
}

export interface LawHit {
  passage: LawPassage;
  score: number;
}

/** BM25 over the passages: no extra model, instant, and the same question always finds the same law. */
export class LawLibrary {
  readonly sources: ReadonlyMap<string, LawSource>;
  private readonly docs: { passage: LawPassage; terms: Map<string, number>; length: number }[];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;

  constructor(file: LawFile) {
    this.sources = new Map(file.sources.map((s) => [s.id, s]));
    this.docs = file.passages.map((passage) => {
      const words = tokens(`${passage.heading} ${passage.heading} ${passage.text}`);
      const terms = new Map<string, number>();
      for (const word of words) terms.set(word, (terms.get(word) ?? 0) + 1);
      for (const word of terms.keys()) this.docFreq.set(word, (this.docFreq.get(word) ?? 0) + 1);
      return { passage, terms, length: words.length };
    });
    this.avgLength = this.docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, this.docs.length);
  }

  get size(): number {
    return this.docs.length;
  }

  /** The best `limit` passages for `query`, at most `perSection` pieces of one long section. */
  search(query: string, limit = 3, minScore = 3, perSection = 2): LawHit[] {
    const words = [...new Set(tokens(query))];
    if (words.length === 0) return [];
    const k1 = 1.2;
    const b = 0.75;
    const n = this.docs.length;
    const hits: LawHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const word of words) {
        const tf = doc.terms.get(word);
        if (!tf) continue;
        const df = this.docFreq.get(word) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / this.avgLength));
      }
      score *= focus(doc.passage.id);
      if (score >= minScore) hits.push({ passage: doc.passage, score });
    }
    hits.sort((a, b2) => b2.score - a.score);
    const perSectionCount = new Map<string, number>();
    const best: LawHit[] = [];
    for (const hit of hits) {
      const section = hit.passage.id.replace(/:\d+$/, '');
      const count = perSectionCount.get(section) ?? 0;
      if (count >= perSection) continue;
      perSectionCount.set(section, count + 1);
      best.push(hit);
      if (best.length === limit) break;
    }
    return best;
  }

  /**
   * Which of `passages` an answer is really built on, by shared words (Tagalog answers are mapped to
   * the laws' English). Small models often give the wrong passage number for a right answer.
   */
  static closest(answer: string, passages: readonly { text: string }[], minShared = 3): number {
    const words = new Set(tokens(answer));
    let best = -1;
    let bestScore = minShared - 1;
    passages.forEach((passage, i) => {
      const score = new Set(tokens(passage.text).filter((word) => words.has(word))).size;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    return best;
  }
}

export function loadLawLibrary(): LawLibrary {
  return new LawLibrary(JSON.parse(readFileSync(FILE, 'utf8')) as LawFile);
}
