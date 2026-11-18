import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMedia, runFfmpeg } from "@app-story/shared";

/*
 * The music's beat, so a cut can land on it. FFmpeg decodes the track into two bands: the
 * lows (kick, bass) and the highs (snare, hats). Where either gets suddenly louder is an
 * onset; the time between onsets that repeats most is the beat's period, and the offset that
 * lines a grid of that period up with the most onsets is its phase. A track without a steady
 * beat (an ambient pad, speech) has no answer, and then nothing is lined up.
 */

const RATE = 11025;
/** Samples per analysis frame (about 23 ms). */
const HOP = 256;
/** At most this much of the track is read: the beat of a song stays put. */
const MAX_SECONDS = 120;
/** Below this, the repeat in the onsets is too weak to call a beat (steady noise can reach 0.11 by chance). */
const MIN_CONFIDENCE = 0.2;

export interface Beats {
  /** Seconds between beats. */
  periodSec: number;
  /** When the first beat falls in the track, in [0, periodSec). */
  phaseSec: number;
  bpm: number;
  /** How strongly the onsets repeat at the period (0-1). */
  confidence: number;
  /** The track's full length. */
  durationSec: number;
}

/** The beat of an audio file, or undefined when it has no steady one. */
export async function musicBeats(file: string): Promise<Beats | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "app-story-beats-"));
  try {
    const raw = join(dir, "bands.f32");
    await runFfmpeg([
      "-t",
      String(MAX_SECONDS),
      "-i",
      file,
      "-filter_complex",
      "[0:a]aformat=channel_layouts=mono,asplit[a][b];[a]lowpass=f=150[low];[b]highpass=f=2000[high];[low][high]amerge=inputs=2[out]",
      "-map",
      "[out]",
      "-ar",
      String(RATE),
      "-f",
      "f32le",
      raw,
    ]);
    const bytes = await readFile(raw);
    const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    const { durationSec } = await probeMedia(file);
    const found = findBeats(onsets(samples), RATE / HOP);
    return found ? { ...found, durationSec } : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** How suddenly the sound gets louder, frame by frame: both bands, from interleaved [low, high] samples. */
export function onsets(interleaved: Float32Array): Float32Array {
  const frames = Math.floor(interleaved.length / 2 / HOP);
  const out = new Float32Array(frames);
  const previous = [0, 0];
  for (let f = 0; f < frames; f++) {
    let total = 0;
    for (let band = 0; band < 2; band++) {
      let energy = 0;
      for (let i = 0; i < HOP; i++) {
        const s = interleaved[(f * HOP + i) * 2 + band] as number;
        energy += s * s;
      }
      const level = Math.log(1e-6 + Math.sqrt(energy / HOP));
      if (f > 0) total += Math.max(0, level - (previous[band] as number));
      previous[band] = level;
    }
    out[f] = total;
  }
  return out;
}

/** The beat in an onset curve sampled `rate` times a second: period and phase, or undefined. */
export function findBeats(envelope: Float32Array, rate: number): Omit<Beats, "durationSec"> | undefined {
  const n = envelope.length;
  if (n < rate * 4) return undefined;
  const mean = envelope.reduce((a, b) => a + b, 0) / n;
  const centred = envelope.map((v) => v - mean);
  const correlate = (lag: number) => {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += (centred[i] as number) * (centred[i - lag] as number);
    return sum / (n - lag);
  };
  const zero = correlate(0);
  if (zero <= 0) return undefined;

  // The period: the lag the onsets repeat at most, between 60 and 180 beats a minute,
  // leaning toward 120 (a lag at half or double the beat repeats too).
  const minLag = Math.floor((rate * 60) / 180);
  const maxLag = Math.ceil((rate * 60) / 60);
  const score: number[] = [];
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * rate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2);
    score[lag] = (correlate(lag) / zero) * prior;
    if (best < 0 || (score[lag] as number) > (score[best] as number)) best = lag;
  }
  const confidence = correlate(best) / zero;
  if (confidence < MIN_CONFIDENCE) return undefined;

  // A whole frame is too coarse a period: off by 1%, a grid drifts half a beat in a minute.
  // So the period and the phase are found together, finely around the best lag: the grid
  // that lands on the most onsets across the whole track.
  let grid = { lag: best, start: 0, sum: -1 };
  for (let lag = best - 1; lag <= best + 1; lag += 0.005) {
    for (let start = 0; start < lag; start += 0.5) {
      let sum = 0;
      for (let t = start; t < n - 1; t += lag) {
        const i = Math.floor(t);
        const f = t - i;
        sum += (envelope[i] as number) * (1 - f) + (envelope[i + 1] as number) * f;
      }
      if (sum > grid.sum) grid = { lag, start, sum };
    }
  }
  const periodSec = grid.lag / rate;
  return { periodSec, phaseSec: grid.start / rate, bpm: 60 / periodSec, confidence: Math.min(1, confidence) };
}

/**
 * How far into the music it starts (ms) so that a beat lands at `atMs` of the video. The
 * music loops from the start of the video and fades in over its first second, so starting
 * it up to one beat in is not heard. 0 when the moment falls where the loop would break the grid.
 */
export function beatOffsetMs(beats: Beats, atMs: number): number {
  const period = beats.periodSec * 1000;
  const length = beats.durationSec * 1000;
  const into = length > 0 ? atMs % length : atMs;
  const offset = (((beats.phaseSec * 1000 - into) % period) + period) % period;
  return length > 0 && into + offset >= length ? 0 : Math.round(offset);
}
