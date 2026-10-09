import type { ExplanationLevel, Language, Preferences } from '@linaw/contract';

export type TextSize = 'normal' | 'large' | 'larger';
export type ReadSpeed = 'slower' | 'normal' | 'faster';

export interface Settings {
  textSize: TextSize;
  highContrast: boolean;
  readSpeed: ReadSpeed;
  level: ExplanationLevel;
  showTranscript: boolean;
  language: Language;
}

export const DEFAULT_SETTINGS: Settings = {
  textSize: 'large',
  highContrast: false,
  readSpeed: 'slower',
  level: 'simple',
  showTranscript: true,
  language: 'tl',
};

/** "large" (A+) matches the design's sizes; 1rem = 16px there. */
export const TEXT_SCALE: Record<TextSize, number> = { normal: 0.9, large: 1, larger: 1.15 };
export const SPEECH_RATE: Record<ReadSpeed, number> = { slower: 0.8, normal: 1, faster: 1.2 };

const STORAGE_KEY = 'linaw.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode); settings then last for this visit only.
  }
}

export function toPreferences(settings: Settings): Preferences {
  return { level: settings.level, language: settings.language };
}
