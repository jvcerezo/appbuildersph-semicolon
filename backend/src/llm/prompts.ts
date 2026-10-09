import { z } from 'zod';
import type { Language } from '@linaw/contract';
import type { ChatMessage, JsonRequest } from './ollama';

const RULES: Record<Language, string[]> = {
  tl: [
    'Ikaw si Linaw. Tinutulungan mo ang karaniwang Pilipino na maintindihan ang isang pagdinig o paglilitis.',
    'Sumulat sa simpleng Tagalog, gamit ang pang-araw-araw na salita.',
    'Gamitin LAMANG ang sinabi sa pagdinig. Huwag mag-imbento ng pangalan, petsa o detalye.',
    'Huwag kailanman magbigay ng legal na payo o sabihin kung ano ang dapat gawin ng tao.',
  ],
  en: [
    'You are Linaw. You help ordinary Filipinos understand a hearing or trial.',
    'Write in plain, everyday English.',
    'Use ONLY what was said in the hearing. Never invent names, dates or details.',
    'Never give legal advice or tell anyone what they should do.',
  ],
};

interface NowExample {
  term: string;
  before: string[];
  line: string;
  now: Record<Language, string>;
}

/** Small models copy worked examples far better than they follow instructions. */
const NOW_EXAMPLES: NowExample[] = [
  {
    term: 'Recess',
    before: ['We have no further questions for this witness.'],
    line: 'The Chair declares a ten-minute recess.',
    now: {
      tl: 'Magpapahinga muna ang pagdinig nang sampung minuto bago ituloy.',
      en: 'The hearing pauses for ten minutes before it continues.',
    },
  },
  {
    term: 'Overruled',
    before: ['Objection, Your Honor. The question is leading the witness.'],
    line: 'Overruled. The witness may answer.',
    now: {
      tl: 'Hindi tinanggap ng namumuno ang pagtutol, kaya puwede nang sumagot ang testigo.',
      en: 'The presiding officer rejected the objection, so the witness can now answer.',
    },
  },
];

/** "Simpler": the same meaning and example in easier words. */
export function simpler(args: {
  term: string;
  meaning: string;
  example: string;
  language: Language;
}): JsonRequest<{ meaning: string; example: string }> {
  const { term, meaning, example, language } = args;
  const task =
    language === 'tl'
      ? 'Isulat muli ang meaning at example nang MAS SIMPLE, para maintindihan ng batang 10 taong gulang: maiikling pangungusap at karaniwang salita. Huwag baguhin ang ibig sabihin.'
      : 'Rewrite the meaning and example SIMPLER, so a 10-year-old understands: short sentences, common words. Keep the meaning the same.';
  const facts =
    language === 'tl'
      ? `Termino: ${term}\nmeaning: ${meaning}\nexample: ${example}`
      : `Term: ${term}\nmeaning: ${meaning}\nexample: ${example}`;
  const text = { type: 'string', minLength: 5, maxLength: 220 };
  return {
    messages: [
      { role: 'system', content: [...RULES[language], task].join('\n') },
      { role: 'user', content: facts },
    ],
    format: { type: 'object', properties: { meaning: text, example: text }, required: ['meaning', 'example'] },
    schema: z.object({ meaning: z.string().trim().min(5), example: z.string().trim().min(5) }),
    maxTokens: 160,
  };
}

/** "Right now": one sentence on what the term means at this moment of the hearing. */
export function rightNow(args: {
  term: string;
  meaning: string;
  before: string[];
  line: string;
  language: Language;
}): JsonRequest<{ now: string }> {
  const { term, meaning, before, line, language } = args;
  const task =
    language === 'tl'
      ? 'Isulat ang "now": ISANG maikling pangungusap (hanggang 20 salita) kung ano ang ibig sabihin ng termino sa pangungusap kung saan ito nabanggit. Tungkol lang sa sandaling iyon, hindi sa buong pagdinig.'
      : 'Write "now": ONE short sentence (up to 20 words) on what the term means in the sentence where it was said. Only about that moment, not the whole hearing.';

  const ask = (example: { term: string; before: string[]; line: string }, exampleMeaning?: string): string =>
    language === 'tl'
      ? [
          `Termino: ${example.term}`,
          exampleMeaning ? `Kahulugan: ${exampleMeaning}` : '',
          example.before.length > 0 ? `Bago nito: ${example.before.join(' ')}` : '',
          `Pangungusap na may termino: "${example.line}"`,
        ].filter(Boolean).join('\n')
      : [
          `Term: ${example.term}`,
          exampleMeaning ? `Meaning: ${exampleMeaning}` : '',
          example.before.length > 0 ? `Just before: ${example.before.join(' ')}` : '',
          `Sentence with the term: "${example.line}"`,
        ].filter(Boolean).join('\n');

  const messages: ChatMessage[] = [{ role: 'system', content: [...RULES[language], task].join('\n') }];
  for (const example of NOW_EXAMPLES) {
    messages.push({ role: 'user', content: ask(example) });
    messages.push({ role: 'assistant', content: JSON.stringify({ now: example.now[language] }) });
  }
  messages.push({ role: 'user', content: ask({ term, before, line }, meaning) });

  return {
    messages,
    format: { type: 'object', properties: { now: { type: 'string', minLength: 10, maxLength: 200 } }, required: ['now'] },
    schema: z.object({ now: z.string().trim().min(10) }),
    maxTokens: 90,
  };
}
