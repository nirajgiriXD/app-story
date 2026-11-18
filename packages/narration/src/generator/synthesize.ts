import { join } from "node:path";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { AudioClip, NarrationScript } from "@app-story/contracts";
import { ensureDir, mapWithConcurrency, probeMedia, runFfmpeg, runProcess, type Logger } from "@app-story/shared";
import type { TTSProvider } from "../providers/tts";
import { anchorTimes, parseAnchors } from "../synchronization/anchors";
import { canTimeWords, timeWords, wordTimingEnabled } from "../synchronization/words";

/** Finished clips for lines that were spoken before, keyed by the line's text. */
export interface SpeechCache {
  get(text: string): Buffer | undefined;
  set(text: string, audio: Buffer): void;
}

/** Spoken-word loudness target (EBU R128 style), the same for every clip. */
const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";

/**
 * A light voice-over chain, as an audio engineer would put on a narrator: cut rumble below
 * 80 Hz, tame sharp "s" sounds, even out loud and quiet words, and lift the presence range
 * a little so the voice reads clearly over music. Loudness is set after it.
 */
export const VOICE_CHAIN = [
  "highpass=f=80",
  "deesser=i=0.35:m=0.5:f=0.5",
  "acompressor=threshold=-22dB:ratio=2.5:attack=8:release=120:knee=4",
  "equalizer=f=3200:t=q:w=1.0:g=1.5",
].join(",");

/**
 * Speak the intro, every segment and the outro as separate clips, normalise loudness,
 * and measure each clip's real duration so the recording can be paced to it. Clips stay
 * uncompressed (WAV) until the final render, which encodes the audio once.
 */
export async function synthesizeNarration(
  script: NarrationScript,
  tts: TTSProvider,
  dir: string,
  log: Logger,
  cache?: SpeechCache,
  options: { language?: string } = {},
): Promise<AudioClip[]> {
  // Languages written without spaces are timed by text length (see canTimeWords).
  const language = options.language ?? "en";
  const timeTheWords = !tts.silent && wordTimingEnabled() && canTimeWords(language);
  await ensureDir(dir);
  type Item = Omit<AudioClip, "path" | "duration_ms">;
  const all: Item[] = [
    { id: "intro", kind: "intro", text: script.intro, step_ids: [] },
    ...script.segments.map((s, i): Item => ({ id: `seg-${String(i + 1).padStart(2, "0")}`, kind: "segment", text: s.text, step_ids: s.step_ids })),
    { id: "outro", kind: "outro", text: script.outro, step_ids: [] },
  ];
  // Anchor markers are never spoken or captioned: each line is read without them.
  const parsed = new Map(all.map((item) => [item.id, parseAnchors(item.text, item.step_ids)]));
  const items = all
    .map((item) => ({ ...item, text: (parsed.get(item.id) as ReturnType<typeof parseAnchors>).text }))
    .filter((item) => item.text.trim().length > 0);

  return mapWithConcurrency(items, 3, async (item) => {
    const path = join(dir, `${item.id}.wav`);
    const cached = cache?.get(item.text);
    if (cached) {
      await writeFile(path, cached);
    } else {
      // Raw speech in whatever format the provider returns; FFmpeg reads it by content.
      const raw = join(dir, `${item.id}.raw.wav`);
      await tts.synthesize(item.text, raw, { language });
      if (tts.silent) {
        await rename(raw, path); // already WAV, and nothing to normalise in silence
      } else {
        await normalize(raw, path).catch(async (error: Error) => {
          log.warn({ clip: item.id, error: error.message }, "loudness normalisation failed; using raw audio");
          await runFfmpeg(["-i", raw, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", path]);
        });
        await rm(raw, { force: true });
      }
      cache?.set(item.text, await readFile(path));
    }
    const probe = await probeMedia(path);
    // When each word is spoken: exact captions. Optional: without it, captions are timed by length.
    const words = !timeTheWords
      ? undefined
      : await timeWords(path, item.text, language).catch((error: Error) => {
          log.warn({ clip: item.id, error: error.message }, "word timing failed; captions are timed by text length");
          return undefined;
        });
    log.info({ clip: item.id, seconds: probe.durationSec.toFixed(1), cached: Boolean(cached), words: words?.length ?? 0 }, "narration clip ready");
    const duration_ms = Math.round(probe.durationSec * 1000);
    const anchors = anchorTimes(parsed.get(item.id) as ReturnType<typeof parseAnchors>, duration_ms, words);
    return { ...item, path, duration_ms, ...(words ? { words } : {}), ...(anchors.length ? { anchors } : {}) };
  });
}

/**
 * Two-pass loudness normalisation: measure the clip, then correct it with one linear gain.
 * A single pass works on the fly and pumps the volume up and down inside short clips.
 */
async function normalize(input: string, output: string): Promise<void> {
  const measure = await runProcess("ffmpeg", ["-hide_banner", "-i", input, "-af", `${VOICE_CHAIN},${LOUDNORM}:print_format=json`, "-f", "null", "-"]);
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(measure.stderr)?.[0];
  if (measure.code !== 0 || !json) throw new Error("could not measure loudness");
  const m = JSON.parse(json) as Record<string, string>;
  const measured = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;
  await runFfmpeg(["-i", input, "-af", `${VOICE_CHAIN},${LOUDNORM}:${measured}:linear=true`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", output]);
}
