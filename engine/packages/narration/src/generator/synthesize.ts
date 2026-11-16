import { join } from "node:path";
import { rename } from "node:fs/promises";
import type { AudioClip, NarrationScript } from "@showrun/contracts";
import { ensureDir, mapWithConcurrency, probeMedia, runFfmpeg, type Logger } from "@showrun/shared";
import type { TTSProvider } from "../providers/tts";

/**
 * Speak the intro, every segment and the outro as separate clips, normalise loudness,
 * and measure each clip's real duration so the recording can be paced to it.
 */
export async function synthesizeNarration(
  script: NarrationScript,
  tts: TTSProvider,
  dir: string,
  log: Logger,
): Promise<AudioClip[]> {
  await ensureDir(dir);
  type Item = Omit<AudioClip, "path" | "duration_ms">;
  const all: Item[] = [
    { id: "intro", kind: "intro", text: script.intro, step_ids: [] },
    ...script.segments.map((s, i): Item => ({ id: `seg-${String(i + 1).padStart(2, "0")}`, kind: "segment", text: s.text, step_ids: s.step_ids })),
    { id: "outro", kind: "outro", text: script.outro, step_ids: [] },
  ];
  const items = all.filter((item) => item.text.trim().length > 0);

  return mapWithConcurrency(items, 3, async (item) => {
    const raw = join(dir, `${item.id}.raw.mp3`);
    const path = join(dir, `${item.id}.mp3`);
    await tts.synthesize(item.text, raw);
    if (tts.silent) {
      // Nothing to normalise in silence.
      await rename(raw, path);
    } else {
      try {
        await runFfmpeg(["-i", raw, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100", "-ac", "2", "-b:a", "192k", path]);
      } catch (error) {
        log.warn({ clip: item.id, error: (error as Error).message }, "loudness normalisation failed; using raw audio");
        await rename(raw, path);
      }
    }
    const probe = await probeMedia(path);
    log.info({ clip: item.id, seconds: probe.durationSec.toFixed(1) }, "narration clip ready");
    return { ...item, path, duration_ms: Math.round(probe.durationSec * 1000) };
  });
}
