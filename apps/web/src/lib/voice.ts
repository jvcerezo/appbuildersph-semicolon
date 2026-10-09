import { desktop } from './desktop';

/** A spoken question longer than this is cut off; the contract allows about 30 s. */
export const MAX_QUESTION_SEC = 30;

const PREFERRED_MIME = 'audio/webm;codecs=opus';

export interface VoiceRecording {
  mimeType: string;
  /** Stops and returns the clip. */
  finish: () => Promise<Blob>;
  /** Stops and throws the clip away. */
  cancel: () => void;
}

export class MicUnavailableError extends Error {
  constructor() {
    super('Linaw can’t use the microphone. Allow microphone access, or type your question.');
  }
}

/**
 * Push to talk: records the microphone only (the hearing is captured separately, from the speakers).
 * In the desktop app the speakers are turned down while recording, so the mic hears the user and
 * not the video; the hearing transcript is unaffected. Echo cancellation helps on the rest.
 */
export async function recordQuestion(onLimit: () => void): Promise<VoiceRecording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch {
    throw new MicUnavailableError();
  }
  await desktop?.duckVolume(true).catch(() => false);

  const mimeType = MediaRecorder.isTypeSupported(PREFERRED_MIME) ? PREFERRED_MIME : '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const parts: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) parts.push(event.data);
  });
  recorder.start();
  const limit = window.setTimeout(onLimit, MAX_QUESTION_SEC * 1000);

  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    window.clearTimeout(limit);
    stream.getTracks().forEach((track) => track.stop());
    void desktop?.duckVolume(false).catch(() => undefined);
  };

  return {
    mimeType: recorder.mimeType || PREFERRED_MIME,
    finish: () =>
      new Promise<Blob>((resolve) => {
        recorder.addEventListener('stop', () => resolve(new Blob(parts, { type: recorder.mimeType || PREFERRED_MIME })), { once: true });
        if (recorder.state !== 'inactive') recorder.stop();
        release();
      }),
    cancel: () => {
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}

/** Blob to base64, for `ask.audio`. */
export function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the recording'));
    reader.readAsDataURL(blob);
  });
}
