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

const WHAT_SAID_EXAMPLE = {
  parts: [
    ['The witness is reminded that she remains under oath.', 'Counsel, please proceed with your questions.'],
    ['Mr. President, may we ask for a ten-minute recess?', 'Granted. The session is suspended for ten minutes.'],
  ],
  points: {
    tl: [
      'Pinaalalahanan ang testigo na nanunumpa pa rin siyang magsasabi ng totoo, at itinuloy ang pagtatanong.',
      'Humiling ang isang panig ng sampung minutong pahinga, at pinayagan ito.',
    ],
    en: [
      'The witness was reminded that she is still under oath, and the questioning went on.',
      'One side asked for a ten-minute break, and it was granted.',
    ],
  },
};

/**
 * "What did they say?": one plain sentence for one stretch of the hearing.
 * One call per stretch, because a 4B model given the whole window summed up
 * only the start, or mixed stretches up and invented rulings.
 */
export function whatSaid(args: { lines: string[]; language: Language }): JsonRequest<{ point: string }> {
  const { lines, language } = args;
  const task =
    language === 'tl'
      ? 'Para sa taong hindi nakasunod sa pagdinig, isulat ang "point": ISANG maikling pangungusap kung ano ang sinabi sa mga linyang ito. Banggitin kung sino ang nagsalita kung malinaw (hal. ang depensa, ang prosekusyon, ang namumuno). Huwag sabihing may desisyon kung walang sinabing desisyon.'
      : 'For someone who lost track of the hearing, write "point": ONE short sentence on what was said in these lines. Say who spoke when it is clear (e.g. the defense, the prosecution, the presiding officer). Never say something was decided unless a decision was said.';
  const messages: ChatMessage[] = [{ role: 'system', content: [...RULES[language], task].join('\n') }];
  WHAT_SAID_EXAMPLE.parts.forEach((part, i) => {
    messages.push({ role: 'user', content: part.join('\n') });
    messages.push({ role: 'assistant', content: JSON.stringify({ point: WHAT_SAID_EXAMPLE.points[language][i] }) });
  });
  messages.push({ role: 'user', content: lines.join('\n') });
  return {
    messages,
    format: { type: 'object', properties: { point: { type: 'string', minLength: 5, maxLength: 250 } }, required: ['point'] },
    schema: z.object({ point: z.string().trim().min(5) }),
    maxTokens: 90,
  };
}

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
