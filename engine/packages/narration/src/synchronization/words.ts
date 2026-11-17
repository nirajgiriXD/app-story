import { spawn } from "node:child_process";
import type { WordTiming } from "@app-story/contracts";
import { AppStoryError } from "@app-story/shared";

/*
 * When each word of a narration clip is spoken. A small speech-recognition model (Whisper,
 * run locally on the CPU) listens to the clip and times the words it hears; those are then
 * matched to the script's own words, so the result always has the script's words (with
 * their spelling and punctuation), even where the model misheard one.
 */

/** English Whisper exported with the attention the word times come from. About 300 MB, downloaded once. */
export const WORD_TIMING_MODEL = "onnx-community/whisper-base.en_timestamped";

type Recognizer = (audio: Float32Array, options: { return_timestamps: "word" }) => Promise<unknown>;

let loading: Promise<Recognizer> | undefined;
/** One clip at a time: the model is not safe to run in parallel and would not be faster. */
let queue: Promise<unknown> = Promise.resolve();

function loadRecognizer(): Promise<Recognizer> {
  loading ??= import("@huggingface/transformers")
    .then(
      async ({ pipeline }) => (await pipeline("automatic-speech-recognition", WORD_TIMING_MODEL, { dtype: "fp32", device: "cpu" })) as unknown as Recognizer,
    )
    .catch((error: unknown) => {
      loading = undefined;
      throw new AppStoryError("TTS_ERROR", `Could not load the word timing model: ${(error as Error).message}`, {
        hint: "The first run downloads it (~300 MB) from huggingface.co. Set APP_STORY_WORD_TIMING=off to skip word timing.",
        cause: error,
      });
    });
  return loading;
}

/** Word timing is on unless APP_STORY_WORD_TIMING=off. */
export function wordTimingEnabled(): boolean {
  return !/^(off|false|0|no)$/i.test(process.env.APP_STORY_WORD_TIMING?.trim() ?? "");
}

/** When each word of `text` is spoken in the clip at `file` (ms from the clip's start). */
export function timeWords(file: string, text: string): Promise<WordTiming[]> {
  const run = queue.then(async () => {
    const recognize = await loadRecognizer();
    const audio = await readMono16k(file);
    const result = (await recognize(audio, { return_timestamps: "word" })) as { chunks?: { text: string; timestamp: [number, number | null] }[] };
    const heard = (result.chunks ?? []).map((c) => ({
      text: c.text.trim(),
      start_ms: Math.round(c.timestamp[0] * 1000),
      end_ms: Math.round((c.timestamp[1] ?? c.timestamp[0]) * 1000),
    }));
    return alignWords(text, heard, (audio.length / 16_000) * 1000);
  });
  queue = run.catch(() => undefined);
  return run;
}

/** The clip as 16 kHz mono float samples, what the model listens to. */
function readMono16k(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    ffmpeg.stdout.on("data", (c: Buffer) => chunks.push(c));
    ffmpeg.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not read ${file}: ${stderr.trim()}`));
      const all = Buffer.concat(chunks);
      resolve(new Float32Array(all.buffer, all.byteOffset, Math.floor(all.length / 4)).slice());
    });
  });
}

/** A misheard word costs a little more than a missed one, so exact matches always line up. */
const SWAP = 1.4;

const key = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The script's words with the times of the words heard. Words are paired in order by an
 * edit-distance alignment (so a misheard, missing or extra word does not shift the rest);
 * script words left without a time get one shared out between their timed neighbours.
 */
export function alignWords(text: string, heard: readonly WordTiming[], clipMs: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  const a = words.map(key);
  const b = heard.map((h) => key(h.text));
  // cost[i][j]: aligning the first i script words with the first j heard words.
  const cost = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const same = a[i - 1] === b[j - 1] ? 0 : SWAP;
      cost[i]![j] = Math.min(cost[i - 1]![j - 1]! + same, cost[i - 1]![j]! + 1, cost[i]![j - 1]! + 1);
    }
  }
  const timed: (WordTiming | undefined)[] = words.map(() => undefined);
  for (let i = a.length, j = b.length; i > 0 && j > 0; ) {
    const same = a[i - 1] === b[j - 1] ? 0 : SWAP;
    if (cost[i]![j] === cost[i - 1]![j - 1]! + same) {
      // Paired: a match, or a misheard word in its place.
      const h = heard[j - 1] as WordTiming;
      timed[i - 1] = { text: words[i - 1] as string, start_ms: h.start_ms, end_ms: h.end_ms };
      i--;
      j--;
    } else if (cost[i]![j] === cost[i - 1]![j]! + 1) i--;
    else j--;
  }

  // Fill gaps evenly between the timed words around them (or the clip's ends).
  const result: WordTiming[] = [];
  for (let i = 0; i < words.length; ) {
    if (timed[i]) {
      result.push(timed[i] as WordTiming);
      i++;
      continue;
    }
    let end = i;
    while (end < words.length && !timed[end]) end++;
    const from = result[result.length - 1]?.end_ms ?? 0;
    const to = timed[end]?.start_ms ?? clipMs;
    const step = Math.max(0, to - from) / (end - i);
    for (let k = i; k < end; k++) {
      result.push({ text: words[k] as string, start_ms: Math.round(from + step * (k - i)), end_ms: Math.round(from + step * (k - i + 1)) });
    }
    i = end;
  }
  // Never backwards, never past the clip.
  let last = 0;
  for (const w of result) {
    w.start_ms = Math.min(Math.max(w.start_ms, last), clipMs);
    w.end_ms = Math.min(Math.max(w.end_ms, w.start_ms), clipMs);
    last = w.start_ms;
  }
  return result;
}
