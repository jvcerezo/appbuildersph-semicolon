import type { Config } from './config';
import { loadLawLibrary, type LawLibrary } from './law/library';
import { OllamaClient } from './llm/ollama';
import { whisperPrompt } from './stt/vocabulary';
import { WhisperClient } from './stt/whisper';
import { TermFinder } from './terms/finder';
import { loadGlossary, loadWatchlist, phrasesOf, type GlossaryEntry, type WatchEntry } from './terms/glossary';

export interface Services {
  config: Config;
  whisper: WhisperClient;
  whisperPrompt: string;
  ai: OllamaClient;
  glossary: ReadonlyMap<string, GlossaryEntry>;
  watchlist: ReadonlyMap<string, WatchEntry>;
  /** Glossary and watch-list terms; on a tie the glossary wins. */
  finder: TermFinder;
  /** Philippine laws and rules for Ask, built by scripts/build-law.ts. */
  law: LawLibrary;
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
    finder: new TermFinder([...glossary, ...watchlist].map((entry) => ({ id: entry.id, phrases: phrasesOf(entry) }))),
    law: loadLawLibrary(),
  };
}
