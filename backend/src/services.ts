import { loadBriefs, type Brief } from './briefs';
import type { Config } from './config';
import { loadLawLibrary, type LawLibrary } from './law/library';
import { OllamaClient } from './llm/ollama';
import { whisperPrompt } from './stt/vocabulary';
import { WhisperClient } from './stt/whisper';
import { TermFinder } from './terms/finder';
import { loadDrafts, loadGlossary, loadWatchlist, phrasesOf, type DraftEntry, type GlossaryEntry, type WatchEntry } from './terms/glossary';

export interface Services {
  config: Config;
  whisper: WhisperClient;
  whisperPrompt: string;
  ai: OllamaClient;
  glossary: ReadonlyMap<string, GlossaryEntry>;
  watchlist: ReadonlyMap<string, WatchEntry>;
  /** Watch-list terms the AI explained ahead of time, by watch-list id. */
  drafts: ReadonlyMap<string, DraftEntry>;
  /** Glossary and watch-list terms; on a tie the glossary wins. */
  finder: TermFinder;
  /** Philippine laws and rules for Ask, built by scripts/build-law.ts. */
  law: LawLibrary;
  /** Background on the hearing for the AI (CASE_BRIEF). */
  briefs: Brief[];
}

export function createServices(config: Config): Services {
  const glossary = loadGlossary();
  const watchlist = loadWatchlist(glossary);
  return {
    config,
    whisper: new WhisperClient(config.whisperUrl, config.whisperLanguage),
    whisperPrompt: whisperPrompt(glossary.map((entry) => entry.term)),
    ai: new OllamaClient(config.ollamaUrl, config.ollamaModel),
    glossary: new Map(glossary.map((entry) => [entry.id, entry])),
    watchlist: new Map(watchlist.map((entry) => [entry.id, entry])),
    drafts: new Map(loadDrafts(watchlist).map((draft) => [draft.id, draft])),
    finder: new TermFinder([...glossary, ...watchlist].map((entry) => ({ id: entry.id, phrases: phrasesOf(entry) }))),
    law: loadLawLibrary(),
    briefs: loadBriefs(config.caseBriefs),
  };
}
