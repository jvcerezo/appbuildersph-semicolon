import type { Language } from '@linaw/contract';

const LANG_TAGS: Record<Language, string[]> = { tl: ['fil', 'tl'], en: ['en'] };

/**
 * Reads text aloud with an on-device voice. Cloud voices are skipped on
 * purpose: Linaw must not send anything off this computer.
 */
export function readAloud(text: string, language: Language, rate: number): Promise<void> {
  if (!('speechSynthesis' in window)) return Promise.resolve();
  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  utterance.lang = language === 'tl' ? 'fil-PH' : 'en-US';

  const local = synth.getVoices().filter((voice) => voice.localService);
  const voice = local.find((v) => LANG_TAGS[language].some((tag) => v.lang.toLowerCase().startsWith(tag)));
  if (voice) utterance.voice = voice;
  else if (local[0]) utterance.voice = local[0];
  else return Promise.resolve(); // no on-device voice at all

  return new Promise((resolve) => {
    utterance.addEventListener('end', () => resolve(), { once: true });
    utterance.addEventListener('error', () => resolve(), { once: true }); // still resolves, so a caller tracking playback can close out
    synth.speak(utterance);
  });
}

let cloudAudio: HTMLAudioElement | null = null;

/**
 * Plays a Soniox text-to-speech clip the backend sent (read-aloud while online).
 * Rejects on playback failure so the caller can fall back to `readAloud`.
 */
export function playCloudAudio(blob: Blob, rate: number): Promise<void> {
  stopReading();
  const audio = new Audio(URL.createObjectURL(blob));
  audio.playbackRate = rate;
  cloudAudio = audio;
  return new Promise((resolve, reject) => {
    audio.addEventListener('ended', () => resolve(), { once: true });
    audio.addEventListener('pause', () => resolve(), { once: true }); // covers stopReading()'s pause(), which fires neither ended nor error
    audio.addEventListener('error', () => reject(new Error('cloud audio playback failed')), { once: true });
    void audio.play().catch(reject);
  });
}

export function stopReading(): void {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if (cloudAudio) {
    cloudAudio.pause();
    cloudAudio = null;
  }
}
