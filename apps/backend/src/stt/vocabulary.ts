/**
 * Words Whisper should expect in a Philippine hearing. Passing them as the
 * prompt fixes terms it otherwise mishears (in tests, "sine die" came out as
 * "signed die" without it). Whisper reads at most ~220 tokens of prompt, so
 * keep the list short; glossary terms are added in front of these.
 */
const HEARING_WORDS = [
  'sine die',
  'subpoena',
  'subpoena duces tecum',
  'motion to quash',
  'under advisement',
  'hearsay',
  'sustained',
  'overruled',
  'Presiding Officer',
  'Articles of Impeachment',
  'impeachment court',
  'cross-examination',
  'quorum',
  'prima facie',
  'affidavit',
  'testimony',
  'respondent',
  'prosecution',
  'defense counsel',
];

const MAX_PROMPT_CHARS = 700;

export function whisperPrompt(extraTerms: readonly string[] = []): string {
  const words = [...new Set([...extraTerms, ...HEARING_WORDS])];
  let prompt = 'Philippine Senate or court hearing. Legal terms:';
  for (const word of words) {
    if (prompt.length + word.length + 2 > MAX_PROMPT_CHARS) break;
    prompt += ` ${word},`;
  }
  return `${prompt.slice(0, -1)}.`;
}
