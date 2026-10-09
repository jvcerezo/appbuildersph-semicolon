import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export const SAMPLE_RATE = 16000;

const ARGS = [
  '-hide_banner',
  '-loglevel',
  'error',
  // Start decoding as soon as the WebM header arrives instead of buffering to probe it.
  '-fflags',
  'nobuffer',
  '-probesize',
  '4096',
  '-analyzeduration',
  '0',
  '-i',
  'pipe:0',
  '-vn',
  '-ac',
  '1',
  '-ar',
  String(SAMPLE_RATE),
  '-f',
  's16le',
  '-flush_packets',
  '1',
  'pipe:1',
];

export interface DecoderEvents {
  onPcm: (samples: Int16Array) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Decodes the UI's WebM/Opus stream to 16 kHz mono PCM. Only the first chunk has the header, so each `session.start` needs a fresh decoder. */
export class FfmpegDecoder {
  readonly closed: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private leftover = Buffer.alloc(0);
  private ending = false;
  private stderr = '';

  constructor(ffmpegPath: string, events: DecoderEvents) {
    this.child = spawn(ffmpegPath, ARGS, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.closed = new Promise((resolve) => {
      this.child.on('error', (err) => {
        events.onError(`ffmpeg could not start (${err.message}). Is it installed?`);
        resolve();
      });
      this.child.on('close', (code) => {
        if (code !== 0 && !this.ending) {
          const last = this.stderr.trim().split('\n').pop() ?? '';
          events.onError(`ffmpeg stopped reading the audio (exit ${code}). ${last}`.trim());
        }
        events.onClose();
        resolve();
      });
    });
    // Writing after ffmpeg exits raises EPIPE; the 'close' handler reports the exit.
    this.child.stdin.on('error', () => undefined);
    this.child.stderr.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-2000);
    });
    this.child.stdout.on('data', (data: Buffer) => {
      const bytes = this.leftover.length > 0 ? Buffer.concat([this.leftover, data]) : data;
      const usable = bytes.length - (bytes.length % 2);
      this.leftover = Buffer.from(bytes.subarray(usable));
      if (usable === 0) return;
      // Int16Array needs an aligned buffer.
      const copy = new Uint8Array(bytes.subarray(0, usable));
      events.onPcm(new Int16Array(copy.buffer, 0, usable / 2));
    });
  }

  write(chunk: Buffer): void {
    if (!this.ending) this.child.stdin.write(chunk);
  }

  end(): void {
    if (this.ending) return;
    this.ending = true;
    this.child.stdin.end();
  }

  kill(): void {
    this.ending = true;
    this.child.kill();
  }
}
