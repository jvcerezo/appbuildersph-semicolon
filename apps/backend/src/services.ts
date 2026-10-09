import type { Config } from './config';
import { OllamaClient } from './llm/ollama';
import { whisperPrompt } from './stt/vocabulary';
import { WhisperClient } from './stt/whisper';
import { TermFinder } from './terms/finder';
import { loadGlossary, phrasesOf, type GlossaryEntry } from './terms/glossary';

export interface Services {
  config: Config;
  whisper: WhisperClient;
  whisperPrompt: string;
  ai: OllamaClient;
  glossary: ReadonlyMap<string, GlossaryEntry>;
  finder: TermFinder;
}

export function createServices(config: Config): Services {
  const glossary = loadGlossary();
  return {
    config,
    whisper: new WhisperClient(config.whisperUrl, config.whisperLanguage),
    whisperPrompt: whisperPrompt(glossary.map((entry) => entry.term)),
    ai: new OllamaClient(config.ollamaUrl, config.ollamaModel),
    glossary: new Map(glossary.map((entry) => [entry.id, entry])),
    finder: new TermFinder(glossary.map((entry) => ({ id: entry.id, phrases: phrasesOf(entry) }))),
  };
}
