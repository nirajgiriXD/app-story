import type { RenderProps } from "./props";

/*
 * The video's sound, mixed by FFmpeg: every voice clip at its place on the timeline, and
 * the background music looped under it. The music dips under the voice with short fades
 * (so it never jumps in volume), fades in over the first second and out over the last two.
 */

const SAMPLE_RATE = 48000;
const FORMAT = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

export interface AudioMix {
  /** FFmpeg input arguments for the voice clips and the music, in order. */
  inputArgs: string[];
  /** A filter graph that ends in `[aout]`: the full-length mix. */
  filter: string;
}

/**
 * @param firstInput FFmpeg's index of the first input added here (inputs before it are the caller's).
 * @param fileOf the path of a job file (`src` in the props) on disk.
 */
export function buildAudioMix(props: RenderProps, firstInput: number, fileOf: (src: string) => string): AudioMix {
  const totalSec = seconds(props.durationMs);
  const inputArgs: string[] = [];
  const chains: string[] = [`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${totalSec}[base]`];
  const mixed = ["[base]"];
  let input = firstInput;

  for (const [i, clip] of props.audio.entries()) {
    inputArgs.push("-i", fileOf(clip.src));
    const delayMs = Math.max(0, Math.round(clip.startMs));
    chains.push(`[${input}:a]${FORMAT},adelay=${delayMs}:all=1[v${i}]`);
    mixed.push(`[v${i}]`);
    input++;
  }

  if (props.music) {
    inputArgs.push("-stream_loop", "-1", "-i", fileOf(props.music.src));
    chains.push(`[${input}:a]${FORMAT},atrim=duration=${totalSec},asetpts=PTS-STARTPTS,volume='${musicVolumeExpression(props)}':eval=frame[music]`);
    mixed.push("[music]");
  }

  // The silent base sets the length; normalize=0 keeps every input at its own volume.
  chains.push(`${mixed.join("")}amix=inputs=${mixed.length}:duration=first:normalize=0:dropout_transition=0[aout]`);
  return { inputArgs, filter: chains.join(";") };
}

/** The music's volume over time `t` (seconds), as an FFmpeg expression. */
export function musicVolumeExpression(props: RenderProps): string {
  const volume = props.music?.volume ?? 0;
  const ramps = props.audio.map((a) => {
    const start = a.startMs / 1000;
    const end = (a.startMs + a.durationMs) / 1000;
    return `min(clip((t-(${num(start - 0.35)}))/0.35,0,1),clip((${num(end + 0.5)}-t)/0.5,0,1))`;
  });
  const duck = ramps.reduce((acc, ramp) => `max(${acc},${ramp})`, "0");
  const total = num(props.durationMs / 1000);
  return `${num(volume)}*(1-0.6*${duck})*clip(t,0,1)*clip((${total}-t)/2,0,1)`;
}

function seconds(ms: number): string {
  return num(Math.max(0, ms) / 1000);
}

function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** The finished video's loudness: what YouTube and most players aim for, with headroom for encoding. */
export const MASTER_LOUDNESS = { i: -14, tp: -1.5, lra: 11 };

/**
 * The master: the whole mix brought to one loudness with a single gain (from a measurement of
 * the mix, so nothing pumps), then a limiter that keeps peaks under -1 dBFS. Silence is left alone.
 */
export function masterChain(measured: { i: number; tp: number; lra: number; thresh: number; offset: number } | undefined): string {
  const limiter = "alimiter=limit=0.891:attack=5:release=50:level=false";
  if (!measured || !Number.isFinite(measured.i) || measured.i < -70) return `aresample=${SAMPLE_RATE},${limiter}`;
  const t = MASTER_LOUDNESS;
  const m = `measured_I=${num(measured.i)}:measured_TP=${num(measured.tp)}:measured_LRA=${num(measured.lra)}:measured_thresh=${num(measured.thresh)}:offset=${num(measured.offset)}`;
  // loudnorm works at 192 kHz; bring it back to the video's rate.
  return `loudnorm=I=${t.i}:TP=${t.tp}:LRA=${t.lra}:${m}:linear=true,aresample=${SAMPLE_RATE},${limiter}`;
}
