import type { Language } from '@linaw/contract';

const LANG_TAGS: Record<Language, string[]> = { tl: ['fil', 'tl'], en: ['en'] };

/**
 * Reads text aloud with an on-device voice. Cloud voices are skipped on
 * purpose: Linaw must not send anything off this computer.
 */
export function readAloud(text: string, language: Language, rate: number): void {
  if (!('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  utterance.lang = language === 'tl' ? 'fil-PH' : 'en-US';

  const local = synth.getVoices().filter((voice) => voice.localService);
  const voice = local.find((v) => LANG_TAGS[language].some((tag) => v.lang.toLowerCase().startsWith(tag)));
  if (voice) utterance.voice = voice;
  else if (local[0]) utterance.voice = local[0];
  else return; // no on-device voice at all

  synth.speak(utterance);
}

export function stopReading(): void {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
