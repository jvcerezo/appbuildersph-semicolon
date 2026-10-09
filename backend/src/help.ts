import type { Language, SummaryEvent } from '@linaw/contract';
import { LawLibrary, spellOutAcronyms } from './law/library';
import type { OllamaClient, Priority } from './llm/ollama';
import { ask, summaryEvent, summaryOverview, whatSaid } from './llm/prompts';
import type { Line } from './session';

const NOTHING_SAID: Record<Language, string> = {
  tl: 'Walang narinig na nagsalita sa nakaraang ilang minuto.',
  en: 'No one was heard speaking in the last few minutes.',
};

const NOTHING_YET: Record<Language, string> = {
  tl: 'Wala pang narinig na nagsalita sa pagdinig.',
  en: 'No one has been heard speaking in the hearing yet.',
};

// Each point is one AI call (~2 s), so three keeps the wait near 6 s.
const MAX_POINTS = 3;
const LINES_PER_POINT = 4;

export const LINES_PER_EVENT = 6;

// Models asked for "" when nothing is open often write a sentence saying so instead.
const NOTHING_OPEN = /^\s*$|^\s*(wala|walang|none|no\b|there\s+(is|are)\s+no|nothing)/i;

// The overview prompt has to fit gemma's 4k-token context.
const MAX_OVERVIEW_EVENTS = 30;

export interface WhatSaid {
  points: string[];
  /** One quoted line per point: the longest line of its part. */
  sources: string[];
}

export async function whatWasSaid(lines: Line[], language: Language, ai: OllamaClient, context = ''): Promise<WhatSaid> {
  if (lines.length === 0) return { points: [NOTHING_SAID[language]], sources: [] };
  const parts = split(lines, Math.min(MAX_POINTS, Math.ceil(lines.length / LINES_PER_POINT)));
  const answers = await Promise.all(
    parts.map((part) => ai.json(whatSaid({ lines: part.map((line) => line.text), language, context }), 'user')),
  );
  return { points: answers.map((answer) => answer.point), sources: parts.map((part) => longest(part).id) };
}

export interface Summary {
  overview: string;
  events: SummaryEvent[];
  openIssue?: string;
  /** Name for the session, when there was anything to summarize. */
  title?: string;
}

/** One timeline event per stretch of lines. Finished stretches are kept, so each summary only reads what is new. */
export class Summarizer {
  private readonly events = new Map<string, Promise<SummaryEvent>>();
  private readonly done = new Map<string, SummaryEvent>();

  constructor(
    private readonly ai: OllamaClient,
    /** The case brief in each language (backend/briefs/), or "". */
    private readonly context: (language: Language) => string = () => '',
  ) {}

  async summarize(lines: Line[], language: Language): Promise<Summary> {
    if (lines.length === 0) return { overview: NOTHING_YET[language], events: [] };
    const events = await Promise.all(chunk(lines, LINES_PER_EVENT).map((stretch) => this.event(stretch, language, 'user')));
    const { overview, openIssue, title } = await this.ai.json(
      summaryOverview({ events: events.slice(-MAX_OVERVIEW_EVENTS), language, context: this.context(language) }),
      'user',
    );
    return { overview, events, openIssue: NOTHING_OPEN.test(openIssue) ? undefined : openIssue, title };
  }

  /** Writes a finished stretch's event in the background, so the summary is quick later. */
  prepare(stretch: Line[], language: Language): void {
    void this.event(stretch, language, 'background').catch(() => undefined);
  }

  clear(): void {
    this.events.clear();
    this.done.clear();
  }

  private event(stretch: Line[], language: Language, priority: Priority): Promise<SummaryEvent> {
    const first = stretch[0];
    if (!first) return Promise.reject(new Error('empty stretch'));
    const key = `${language}:${first.id}:${stretch.length}`;
    const ready = this.done.get(key);
    if (ready) return Promise.resolve(ready);
    const known = this.events.get(key);
    // A background job may sit behind every card in the queue; a person waiting gets a fresh one instead.
    if (known && priority === 'background') return known;
    const job = this.ai
      .json(summaryEvent({ lines: stretch.map((line) => line.text), language, context: this.context(language) }), priority)
      .then(({ title, detail }): SummaryEvent => ({ t: first.t, title, detail, sources: [longest(stretch).id] }));
    if (stretch.length === LINES_PER_EVENT) {
      this.events.set(key, job);
      job.then((event) => this.done.set(key, event)).catch(() => this.events.delete(key));
    }
    return job;
  }
}

const NO_ADVICE: Record<Language, string> = {
  tl: 'Hindi makapagbibigay si Linaw ng legal na payo o hula. Para sa payo, kumonsulta sa abogado o sa PAO (Public Attorney’s Office).',
  en: 'Linaw can’t give legal advice or predictions. For advice, talk to a lawyer or the PAO (Public Attorney’s Office).',
};

const OFF_TOPIC: Record<Language, string> = {
  tl: 'Ang pagdinig na ito at ang mga batas tungkol dito lang ang alam ni Linaw. Magtanong tungkol sa sinabi rito, sa isang legal na termino, o sa batas.',
  en: 'Linaw only knows about this hearing and the laws behind it. Ask about what was said here, a legal term, or the law.',
};

const BASIS: Record<Language, string> = { tl: 'Batayan', en: 'Based on' };

// Four short passages keep the Ask prompt inside gemma's 4k-token context with the transcript lines.
const LAW_PASSAGES = 4;
const LAW_CHARS = 600;

/** Advice and predictions, in Tagalog and English. The refusal must not depend on a 4B model noticing. */
const ADVICE =
  /\b(dapat\s+(ba|ko|kong|akong|ba\s+akong)|ano\s+ang\s+(dapat|gagawin)\s+ko|kailangan\s+ko\s+bang|pwede\s+ba\s+akong|puwede\s+ba\s+akong|mananalo|matatalo|makukulong|maco-convict|ma-convict|magdemanda|kasuhan|should\s+(i|we)|do\s+i\s+need|can\s+i\s+(sue|file)|will\s+(he|she|they)\s+(be\s+)?(convicted|acquitted|jailed|win|lose|go\s+to\s+jail)|is\s+(he|she)\s+guilty|who\s+will\s+win)\b/i;

const RECENT_LINES = 20;
const RELATED_LINES = 8;
const STOPWORDS = new Set(['what', 'when', 'where', 'which', 'that', 'this', 'with', 'from', 'have', 'they', 'were', 'ang', 'mga', 'nang', 'para', 'kung', 'bakit', 'paano', 'saan', 'sino', 'ano']);

export interface Answer {
  text: string;
  sources: string[];
}

/**
 * Ask, from the transcript, the glossary and the law library. Advice and off-topic questions get fixed
 * lines (D11). The law citation is added here from the passages the model says it used, never written
 * by the model, so a section number can't be invented.
 */
export async function answerQuestion(args: {
  question: string;
  lines: Line[];
  meanings: { term: string; meaning: string }[];
  law: LawLibrary;
  language: Language;
  ai: OllamaClient;
  /** The case brief (backend/briefs/), or "". */
  context?: string;
}): Promise<Answer> {
  const { meanings, language, ai } = args;
  const advice = ADVICE.test(args.question);
  const question = spellOutAcronyms(args.question);
  const lines = relevantLines(question, args.lines);
  const laws = args.law
    .search([question, ...meanings.map((m) => m.term)].join(' '), LAW_PASSAGES)
    .map(({ passage }) => ({ cite: language === 'tl' ? passage.citeTl : passage.cite, text: clip(passage.text, LAW_CHARS) }));
  const reply = await ai.json(
    ask({ question, lines: lines.map((line) => line.text), meanings, laws, advice, language, context: args.context }),
    'user',
  );
  const sources = [...new Set(reply.lines.map((n) => lines[n - 1]?.id).filter((id): id is string => id !== undefined))];
  if (!reply.onTopic) return { text: advice ? NO_ADVICE[language] : OFF_TOPIC[language], sources: [] };
  // Trust the model that it used the law, but check which passage: cite the one the answer matches best.
  const closest = LawLibrary.closest(reply.answer, laws);
  const used = reply.laws.length > 0 && closest >= 0 ? [closest] : [];
  const cited = [...new Set(used.map((i) => laws[i]?.cite).filter((cite): cite is string => cite !== undefined))];
  const basis = cited.length > 0 ? ` (${BASIS[language]}: ${cited.join('; ')})` : '';
  const answer = `${reply.answer}${basis}`;
  return { text: advice ? `${NO_ADVICE[language]} ${answer}` : answer, sources };
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), max * 0.6) + 1).trim()} …`;
}

/** The latest lines, plus older ones that share words with the question, in hearing order. */
function relevantLines(question: string, lines: Line[]): Line[] {
  const recent = lines.slice(-RECENT_LINES);
  const words = new Set(keywords(question));
  const related = lines
    .slice(0, -RECENT_LINES)
    .map((line) => ({ line, score: keywords(line.text).filter((word) => words.has(word)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, RELATED_LINES)
    .map(({ line }) => line);
  return [...related, ...recent].sort((a, b) => a.t - b.t);
}

function keywords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 4 && !STOPWORDS.has(word));
}

function longest(lines: Line[]): Line {
  return lines.reduce((a, b) => (b.text.length > a.text.length ? b : a));
}

/** `count` consecutive parts of near-equal size. */
function split<T>(items: T[], count: number): T[][] {
  return Array.from({ length: count }, (_, i) =>
    items.slice(Math.round((i * items.length) / count), Math.round(((i + 1) * items.length) / count)),
  );
}

/** Consecutive pieces of `size`; the last may be shorter. */
function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}
