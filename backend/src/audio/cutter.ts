export interface Utterance {
  startSec: number;
  durationSec: number;
  samples: Int16Array;
}

export interface CutterOptions {
  sampleRate: number;
  endSilenceMs: number;
  maxClipMs: number;
  minSpeechMs: number;
  /** Kept from before speech starts, so the first word isn't clipped. */
  prerollMs: number;
  trailMs: number;
  /** Speech must be this much louder than the background. */
  marginDb: number;
  quietestSpeechDb: number;
}

const DEFAULTS: CutterOptions = {
  sampleRate: 16000,
  endSilenceMs: 700,
  maxClipMs: 15000,
  minSpeechMs: 300,
  prerollMs: 300,
  trailMs: 200,
  marginDb: 9,
  quietestSpeechDb: -50,
};

const FRAME_MS = 20;
/** Loud frames in a row that start a clip (60 ms). */
const START_FRAMES = 3;

/** Splits PCM into utterances at pauses. Whisper is far more accurate on whole sentences than on fixed slices. */
export class PauseCutter {
  private readonly options: CutterOptions;
  private readonly frameSize: number;
  private readonly partial: Int16Array;
  private partialLength = 0;
  private position = 0;
  private readonly noise = new NoiseFloor();
  private recent: Int16Array[] = [];
  private loudRun = 0;
  private clip: Int16Array[] | null = null;
  private clipStart = 0;
  private speechFrames = 0;
  private silenceFrames = 0;
  private heardSpeech = false;

  constructor(
    private readonly onUtterance: (utterance: Utterance) => void,
    private readonly onFirstSpeech: () => void = () => undefined,
    options: Partial<CutterOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.frameSize = Math.round((this.options.sampleRate * FRAME_MS) / 1000);
    this.partial = new Int16Array(this.frameSize);
  }

  push(samples: Int16Array): void {
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.frameSize - this.partialLength, samples.length - offset);
      this.partial.set(samples.subarray(offset, offset + take), this.partialLength);
      this.partialLength += take;
      offset += take;
      if (this.partialLength === this.frameSize) {
        this.frame(this.partial.slice());
        this.partialLength = 0;
      }
    }
  }

  flush(): void {
    this.finish(this.silenceFrames - this.frames(this.options.trailMs));
  }

  private frame(frame: Int16Array): void {
    const db = levelDb(frame);
    const threshold = Math.max(this.options.quietestSpeechDb, this.noise.level() + this.options.marginDb);
    const loud = db > threshold;
    this.noise.add(db);
    const start = this.position;
    this.position += frame.length;

    if (this.clip === null) {
      this.loudRun = loud ? this.loudRun + 1 : 0;
      this.recent.push(frame);
      if (this.recent.length > this.frames(this.options.prerollMs) + START_FRAMES) this.recent.shift();
      if (this.loudRun < START_FRAMES) return;

      this.clip = this.recent;
      this.recent = [];
      this.clipStart = start + frame.length - this.clip.length * this.frameSize;
      this.speechFrames = this.loudRun;
      this.silenceFrames = 0;
      this.loudRun = 0;
      if (!this.heardSpeech) {
        this.heardSpeech = true;
        this.onFirstSpeech();
      }
      return;
    }

    this.clip.push(frame);
    if (loud) {
      this.speechFrames++;
      this.silenceFrames = 0;
    } else {
      this.silenceFrames++;
    }
    if (this.silenceFrames >= this.frames(this.options.endSilenceMs)) {
      this.finish(this.silenceFrames - this.frames(this.options.trailMs));
    } else if (this.clip.length >= this.frames(this.options.maxClipMs)) {
      this.finish(0);
    }
  }

  private finish(trim: number): void {
    const clip = this.clip;
    if (clip === null) return;
    this.clip = null;
    const speechMs = this.speechFrames * FRAME_MS;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    if (speechMs < this.options.minSpeechMs) return;

    const samples = concat(clip.slice(0, clip.length - Math.max(0, trim)));
    const rate = this.options.sampleRate;
    this.onUtterance({ startSec: this.clipStart / rate, durationSec: samples.length / rate, samples });
  }

  private frames(ms: number): number {
    return Math.round(ms / FRAME_MS);
  }
}

/** Background loudness: the quietest 10% of the last ~10 s of frames. */
class NoiseFloor {
  private static readonly WINDOW = 500;
  private static readonly MIN_FRAMES = 25;
  /** Frame counts per whole dB of quietness: bin 0 = 0 dBFS, bin 100 = -100 dBFS or quieter. */
  private readonly bins = new Uint16Array(101);
  private readonly history: number[] = [];

  add(db: number): void {
    const bin = Math.min(100, Math.max(0, Math.round(-db)));
    this.history.push(bin);
    this.bins[bin] = (this.bins[bin] ?? 0) + 1;
    if (this.history.length > NoiseFloor.WINDOW) {
      const old = this.history.shift();
      if (old !== undefined) this.bins[old] = (this.bins[old] ?? 1) - 1;
    }
  }

  level(): number {
    const total = this.history.length;
    if (total < NoiseFloor.MIN_FRAMES) return -100;
    const target = Math.ceil(total * 0.1);
    let seen = 0;
    for (let bin = 100; bin >= 0; bin--) {
      seen += this.bins[bin] ?? 0;
      if (seen >= target) return -bin;
    }
    return 0;
  }
}

function levelDb(frame: Int16Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  const rms = Math.sqrt(sum / frame.length);
  return rms === 0 ? -100 : Math.max(-100, 20 * Math.log10(rms / 32768));
}

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
