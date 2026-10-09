/** Audio capture: a shared tab, all system audio (desktop overlay) or a local file, recorded in small chunks. */

const PREFERRED_MIME = 'audio/webm;codecs=opus';
const CHUNK_MS = 1000;

export class NoAudioError extends Error {
  constructor() {
    super(
      window.linawDesktop
        ? 'Linaw could not hear this computer’s sound. System audio capture works on Windows only for now.'
        : 'The shared tab has no audio. Turn on “Share tab audio” and try again.',
    );
  }
}

export interface AudioSource {
  stream: MediaStream;
  /** Stops capture and releases the tab or file. */
  release: () => void;
}

/**
 * In the browser: opens the share picker for a tab (call from a click handler).
 * In the desktop overlay: the main process answers with all system audio, no picker.
 */
export async function captureScreenAudio(): Promise<AudioSource> {
  // Chrome only offers tab audio together with video, so ask for both and drop the video.
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
    // Chrome-specific hints; other browsers ignore them.
    ...({ preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'exclude' } as object),
  });
  display.getVideoTracks().forEach((track) => track.stop());

  const audioTracks = display.getAudioTracks();
  if (audioTracks.length === 0) {
    display.getTracks().forEach((track) => track.stop());
    throw new NoAudioError();
  }
  const stream = new MediaStream(audioTracks);
  return { stream, release: () => stream.getTracks().forEach((track) => track.stop()) };
}

/** Plays a local file (so the user hears it) and captures its audio as it plays. */
export async function captureFile(file: File): Promise<AudioSource> {
  const url = URL.createObjectURL(file);
  const media = document.createElement('audio');
  media.src = url;
  await media.play();

  const capturable = media as HTMLAudioElement & { captureStream?: () => MediaStream };
  if (!capturable.captureStream) {
    media.pause();
    URL.revokeObjectURL(url);
    throw new Error('This browser cannot read audio from files. Please use Chrome or Edge.');
  }
  const stream = capturable.captureStream();
  media.addEventListener('ended', () => stream.getTracks().forEach((track) => track.stop()));

  return {
    stream,
    release: () => {
      media.pause();
      stream.getTracks().forEach((track) => track.stop());
      URL.revokeObjectURL(url);
    },
  };
}

export interface Recorder {
  mimeType: string;
  stop: () => void;
}

/**
 * Records `stream` and hands each chunk to `onChunk`. The chunks form one
 * continuous WebM stream (only the first one has the header). `onEnded` fires
 * when the source goes away, e.g. the user clicked "Stop sharing".
 */
export function startRecorder(
  stream: MediaStream,
  onChunk: (chunk: Blob) => void,
  onEnded: () => void,
): Recorder {
  const mimeType = MediaRecorder.isTypeSupported(PREFERRED_MIME) ? PREFERRED_MIME : '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) onChunk(event.data);
  });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnded();
  };
  stream.getAudioTracks().forEach((track) => track.addEventListener('ended', end));
  recorder.addEventListener('stop', end);
  recorder.start(CHUNK_MS);

  return {
    mimeType: recorder.mimeType || PREFERRED_MIME,
    stop: () => {
      ended = true; // stopping on purpose is not an "ended" event
      if (recorder.state !== 'inactive') recorder.stop();
    },
  };
}
