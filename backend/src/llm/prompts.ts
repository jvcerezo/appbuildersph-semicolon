import { z } from 'zod';
import type { ExplanationLevel, Language } from '@linaw/contract';
import type { ChatMessage, JsonRequest } from './ollama';

const RULES: Record<Language, string[]> = {
  tl: [
    'Ikaw si Linaw. Tinutulungan mo ang karaniwang Pilipino na maintindihan ang isang pagdinig o paglilitis.',
    'Sumulat sa simpleng Tagalog, gamit ang pang-araw-araw na salita.',
    'Gamitin LAMANG ang sinabi sa pagdinig. Huwag mag-imbento ng pangalan, petsa o detalye.',
    'Huwag kailanman magbigay ng legal na payo o sabihin kung ano ang dapat gawin ng tao.',
    'Ang "Objection" ay pagtutol ng isang abogado, hindi desisyon. May desisyon lang kapag sinabi ito ng namumuno (hal. "Sustained", "Overruled", "Granted", "Denied"). Kung walang ganoon, hindi pa napagpapasyahan.',
  ],
  en: [
    'You are Linaw. You help ordinary Filipinos understand a hearing or trial.',
    'Write in plain, everyday English.',
    'Use ONLY what was said in the hearing. Never invent names, dates or details.',
    'Never give legal advice or tell anyone what they should do.',
    '"Objection" is a lawyer protesting, not a decision. Something is decided only when the presiding officer says so (e.g. "Sustained", "Overruled", "Granted", "Denied"). Without that, it is not decided yet.',
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
      ? 'Para sa taong hindi nakasunod sa pagdinig, isulat ang "point": ISANG maikling pangungusap lang (hanggang 25 salita) kung ano ang sinabi sa mga linyang ito. Banggitin kung sino ang nagsalita kung malinaw (hal. ang depensa, ang prosekusyon, ang namumuno). Huwag sabihing may desisyon kung walang sinabing desisyon.'
      : 'For someone who lost track of the hearing, write "point": just ONE short sentence (up to 25 words) on what was said in these lines. Say who spoke when it is clear (e.g. the defense, the prosecution, the presiding officer). Never say something was decided unless a decision was said.';
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

const EVENT_EXAMPLE = {
  lines: [
    'Mr. President, may we ask for a ten-minute recess?',
    'Granted. The session is suspended for ten minutes.',
    'The session is resumed.',
  ],
  event: {
    tl: { title: 'Sampung minutong pahinga', detail: 'Humiling ang isang panig ng pahinga, pinayagan ito, at itinuloy ang sesyon pagkatapos.' },
    en: { title: 'Ten-minute break', detail: 'One side asked for a break, it was granted, and the session resumed afterwards.' },
  },
};

/** One stretch of the hearing as a Summary timeline event. */
export function summaryEvent(args: { lines: string[]; language: Language }): JsonRequest<{ title: string; detail: string }> {
  const { lines, language } = args;
  const task =
    language === 'tl'
      ? 'Isulat ang nangyari sa bahaging ito ng pagdinig: "title" (hanggang 6 na salita) at "detail" (ISANG maikling pangungusap). Banggitin kung sino ang nagsalita kung malinaw. Huwag sabihing may desisyon kung walang sinabing desisyon.'
      : 'Write what happened in this stretch of the hearing: "title" (up to 6 words) and "detail" (ONE short sentence). Say who spoke when it is clear. Never say something was decided unless a decision was said.';
  const text = { type: 'string', minLength: 3, maxLength: 250 };
  return {
    messages: [
      { role: 'system', content: [...RULES[language], task].join('\n') },
      { role: 'user', content: EVENT_EXAMPLE.lines.join('\n') },
      { role: 'assistant', content: JSON.stringify(EVENT_EXAMPLE.event[language]) },
      { role: 'user', content: lines.join('\n') },
    ],
    format: { type: 'object', properties: { title: text, detail: text }, required: ['title', 'detail'] },
    schema: z.object({ title: z.string().trim().min(3), detail: z.string().trim().min(5) }),
    maxTokens: 120,
  };
}

export interface Overview {
  /** Short name for the session (top bar, library). */
  title: string;
  overview: string;
  /** Empty when nothing is left unresolved. */
  openIssue: string;
}

/** The whole hearing so far, from its timeline events. */
export function summaryOverview(args: { events: { title: string; detail: string }[]; language: Language }): JsonRequest<Overview> {
  const { events, language } = args;
  const task =
    language === 'tl'
      ? 'Mula sa mga pangyayaring ito sa pagdinig, isulat: "overview" (2 hanggang 3 maiikling pangungusap tungkol sa buong pagdinig hanggang ngayon), "openIssue" (ISANG pangungusap tungkol sa isang usaping hindi pa napagpapasyahan, o "" kung wala), at "title" (pangalan ng pagdinig, hanggang 6 na salita).'
      : 'From these events in the hearing, write: "overview" (2 to 3 short sentences about the whole hearing so far), "openIssue" (ONE sentence about an issue not yet decided, or "" if none), and "title" (a name for the hearing, up to 6 words).';
  return {
    messages: [
      { role: 'system', content: [...RULES[language], task].join('\n') },
      { role: 'user', content: events.map((event, i) => `${i + 1}. ${event.title}: ${event.detail}`).join('\n') },
    ],
    format: {
      type: 'object',
      properties: {
        overview: { type: 'string', minLength: 10, maxLength: 500 },
        openIssue: { type: 'string', maxLength: 250 },
        title: { type: 'string', minLength: 3, maxLength: 60 },
      },
      required: ['overview', 'openIssue', 'title'],
    },
    schema: z.object({ overview: z.string().trim().min(10), openIssue: z.string().trim(), title: z.string().trim().min(3) }),
    maxTokens: 260,
  };
}

export interface AskAnswer {
  onTopic: boolean;
  answer: string;
  /** 1-based numbers of the hearing lines the answer is based on. */
  lines: number[];
}

/** Ask: answers from the hearing lines and glossary meanings only. */
export function ask(args: {
  question: string;
  lines: string[];
  meanings: { term: string; meaning: string }[];
  advice: boolean;
  language: Language;
}): JsonRequest<AskAnswer> {
  const { question, lines, meanings, advice, language } = args;
  const tl = language === 'tl';
  const task = tl
    ? [
        'Sagutin ang tanong gamit LAMANG ang mga linya ng pagdinig at ang mga kahulugan sa ibaba. Isulat:',
        '- "onTopic": true kung tungkol ang tanong sa pagdinig, sa mga tao rito, o sa isang legal na termino o proseso; false kung hindi.',
        '- "answer": 1 hanggang 3 maiikling pangungusap. Kung wala sa mga linya ang sagot, sabihing hindi pa ito nabanggit sa pagdinig.',
        '- "lines": ang numero ng mga linyang pinagbatayan ng sagot.',
      ]
    : [
        'Answer the question using ONLY the hearing lines and the meanings below. Write:',
        '- "onTopic": true if the question is about the hearing, its people, or a legal term or procedure; false if not.',
        '- "answer": 1 to 3 short sentences. If the lines do not say, say it has not come up in the hearing yet.',
        '- "lines": the numbers of the lines the answer is based on.',
      ];
  if (advice) {
    task.push(
      tl
        ? 'Humihingi ang tanong ng payo o hula. HUWAG magpayo o manghula kung ano ang mangyayari. Ipaliwanag lang ang kaugnay na termino o hakbang ng proseso.'
        : 'The question asks for advice or a prediction. Do NOT advise or predict what will happen. Only explain the related term or step of the procedure.',
    );
  }
  const heard = lines.map((text, i) => `[${i + 1}] ${text}`).join('\n') || (tl ? '(wala pa)' : '(none yet)');
  const known = meanings.map((m) => `- ${m.term}: ${m.meaning}`).join('\n');
  const content = tl
    ? `Mga linya ng pagdinig:\n${heard}${known ? `\n\nMga kahulugan:\n${known}` : ''}\n\nTanong: ${question}`
    : `Hearing lines:\n${heard}${known ? `\n\nMeanings:\n${known}` : ''}\n\nQuestion: ${question}`;
  return {
    messages: [
      { role: 'system', content: [...RULES[language], ...task].join('\n') },
      { role: 'user', content },
    ],
    format: {
      type: 'object',
      properties: {
        onTopic: { type: 'boolean' },
        answer: { type: 'string', minLength: 5, maxLength: 500 },
        lines: { type: 'array', items: { type: 'integer' } },
      },
      required: ['onTopic', 'answer', 'lines'],
    },
    schema: z.object({ onTopic: z.boolean(), answer: z.string().trim().min(5), lines: z.array(z.number().int()) }),
    maxTokens: 220,
  };
}

const CARD_EXAMPLE = {
  term: 'Subpoena',
  line: 'The committee will issue a subpoena to the former secretary.',
  card: {
    tl: {
      simple: {
        meaning: 'Utos ng korte o ng komite na humarap ang isang tao o magdala ng dokumento.',
        example: 'Parang opisyal na imbitasyon na hindi puwedeng tanggihan nang walang dahilan.',
      },
      detailed: {
        meaning:
          'Utos ng korte o ng komite na humarap ang isang tao o magdala ng dokumento. Ginagamit ito para makuha ang testimonya o ebidensiyang kailangan. Kapag hindi sumunod nang walang sapat na dahilan, puwede itong humantong sa parusa.',
        example: 'Parang opisyal na imbitasyon na may pirma ng awtoridad, kaya hindi ito puwedeng balewalain.',
      },
      now: 'Uutusan ng komite ang dating kalihim na humarap sa pagdinig.',
    },
    en: {
      simple: {
        meaning: 'An order from a court or committee to appear or to bring documents.',
        example: 'Like an official invitation you can’t turn down without a good reason.',
      },
      detailed: {
        meaning:
          'An order from a court or committee to appear or to bring documents. It is used to get testimony or evidence the hearing needs. Ignoring it without a good reason can lead to a penalty.',
        example: 'Like an official invitation signed by an authority, so it can’t simply be ignored.',
      },
      now: 'The committee will order the former secretary to appear at the hearing.',
    },
  },
};

export interface AiCardText {
  /** Whether the term is legal or procedural jargon at all; spotted terms that aren't get no card. */
  jargon: boolean;
  english: string;
  meaning: string;
  example: string;
  now: string;
}

/** A whole AI-explained card. The English meaning comes first because small models explain more accurately that way. */
export function aiCard(args: {
  term: string;
  before: string[];
  line: string;
  language: Language;
  level: ExplanationLevel;
}): JsonRequest<AiCardText> {
  const { term, before, line, language, level } = args;
  const tl = language === 'tl';
  const meaningRule =
    level === 'detailed'
      ? tl
        ? '- meaning: 2 hanggang 3 maiikling pangungusap sa simpleng Tagalog: ano ito, para saan, at ano ang karaniwang kasunod nito.'
        : '- meaning: 2 to 3 short sentences in plain English: what it is, what it is for, and what usually follows.'
      : tl
        ? '- meaning: ISANG maikling pangungusap sa simpleng Tagalog.'
        : '- meaning: ONE short sentence in plain English.';
  const task = tl
    ? [
        'Ipaliwanag ang termino. Isulat:',
        '- jargon: true kung legal o pamprosesong termino na maaaring hindi alam ng karaniwang tao; false kung pangkaraniwang salita, pangalan o lugar.',
        '- english: ang legal na kahulugan nito sa Ingles, isang pangungusap.',
        meaningRule,
        '- example: isang pang-araw-araw na paghahambing na nagsisimula sa "Parang".',
        '- now: ISANG maikling pangungusap kung ano ang ibig sabihin nito sa pangungusap kung saan ito nabanggit.',
      ]
    : [
        'Explain the term. Write:',
        '- jargon: true if it is a legal or procedural term an ordinary person may not know; false if it is an everyday word, a name or a place.',
        '- english: its legal meaning in English, one sentence.',
        meaningRule,
        '- example: an everyday comparison starting with "Like".',
        '- now: ONE short sentence on what it means in the sentence where it was said.',
      ];
  const ask = (t: string, b: string[], l: string): string =>
    tl
      ? [`Termino: ${t}`, b.length > 0 ? `Bago nito: ${b.join(' ')}` : '', `Pangungusap na may termino: ${l}`].filter(Boolean).join('\n')
      : [`Term: ${t}`, b.length > 0 ? `Just before: ${b.join(' ')}` : '', `Sentence with the term: ${l}`].filter(Boolean).join('\n');
  const shot = CARD_EXAMPLE.card[language];
  const text = { type: 'string', minLength: 5, maxLength: level === 'detailed' ? 450 : 250 };
  return {
    messages: [
      { role: 'system', content: [...RULES[language], ...task].join('\n') },
      { role: 'user', content: ask(CARD_EXAMPLE.term, [], CARD_EXAMPLE.line) },
      {
        role: 'assistant',
        content: JSON.stringify({
          jargon: true,
          english: 'A legal order requiring a person to appear or to produce documents.',
          ...shot[level],
          now: shot.now,
        }),
      },
      { role: 'user', content: ask(term, before, line) },
    ],
    format: {
      type: 'object',
      properties: { jargon: { type: 'boolean' }, english: text, meaning: text, example: text, now: text },
      required: ['jargon', 'english', 'meaning', 'example', 'now'],
    },
    schema: z.object({
      jargon: z.boolean(),
      english: z.string().trim(),
      meaning: z.string().trim().min(5),
      example: z.string().trim().min(5),
      now: z.string().trim().min(5),
    }),
    maxTokens: level === 'detailed' ? 360 : 240,
  };
}

/** Finds jargon the glossary and watch list missed. Tested at ~1 s per line; about half its picks need filtering. */
export function spot(args: { line: string }): JsonRequest<{ terms: string[] }> {
  const shots: [string, string[]][] = [
    ['The court finds probable cause and issues a warrant of arrest.', ['probable cause', 'warrant of arrest']],
    ['Good morning, everyone. Please be seated.', []],
  ];
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You read one line from a Philippine Senate hearing or court trial.',
        'List the legal or procedural terms in it that an ordinary Filipino might not understand.',
        'Copy each term EXACTLY as written in the line. A term can be a phrase.',
        'Skip names, places, agencies, numbers, everyday words, and forms of address like "Your Honor" or "Mr. President".',
        'At most 2 terms. If there are none, return an empty list.',
      ].join('\n'),
    },
  ];
  for (const [line, terms] of shots) {
    messages.push({ role: 'user', content: line });
    messages.push({ role: 'assistant', content: JSON.stringify({ terms }) });
  }
  messages.push({ role: 'user', content: args.line });
  return {
    messages,
    format: { type: 'object', properties: { terms: { type: 'array', items: { type: 'string' }, maxItems: 2 } }, required: ['terms'] },
    schema: z.object({ terms: z.array(z.string().trim()) }),
    maxTokens: 60,
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
