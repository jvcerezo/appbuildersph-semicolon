/** Audio capture: a shared tab or all system audio (desktop overlay), recorded in small chunks. */

// captureStream() is widely supported (Chromium/Electron) but isn't in TypeScript's DOM lib yet.
declare global {
  interface HTMLMediaElement {
    captureStream?(): MediaStream;
  }
}

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
  /** Stops capture and releases the tab or system audio. */
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

/**
 * A local file (fallback when a live tab or system capture isn't available). Plays it in real
 * time and captures its decoded audio, so everything downstream works exactly as it does for a
 * live capture — including auto-stop when the file ends (captureScreenAudio's "ended" track event
 * doubles as "stopped sharing" there; here it's "finished playing").
 */
export async function captureFileAudio(file: File): Promise<AudioSource> {
  const url = URL.createObjectURL(file);
  const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
  el.src = url;

  if (typeof el.captureStream !== 'function') {
    URL.revokeObjectURL(url);
    throw new Error('This browser can’t read audio from an uploaded file. Use Chrome, Edge or the Linaw desktop app.');
  }
  try {
    await el.play();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('Linaw couldn’t play that file. Try a different audio or video file.');
  }

  const captured: MediaStream = el.captureStream();
  captured.getVideoTracks().forEach((track) => track.stop());
  const audioTracks = captured.getAudioTracks();
  if (audioTracks.length === 0) {
    el.pause();
    URL.revokeObjectURL(url);
    throw new Error('That file doesn’t have any sound Linaw can listen to.');
  }
  const stream = new MediaStream(audioTracks);
  // startRecorder() listens for the audio track's "ended" event; firing it here on natural
  // end-of-file reuses that exact "source went away" path for auto-stop.
  el.addEventListener('ended', () => stream.getAudioTracks().forEach((track) => track.stop()));

  return {
    stream,
    release: () => {
      el.pause();
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
