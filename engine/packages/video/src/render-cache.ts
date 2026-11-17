import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { CursorPoint } from "@app-story/contracts";
import { sourceFrame } from "./edit";
import type { RenderProps } from "./props";
import { CURSOR_FADE_MS, CURSOR_IDLE_MS, mergeFocusWindows } from "./timeline";

/*
 * Rendering in cached pieces. The video is drawn in short chunks (two seconds, one keyframe
 * interval each), and every chunk is stored under a hash of everything that can change its
 * pixels. Rendering the same cut again then only draws the chunks that changed: the AI review
 * re-framing two steps redraws the seconds around them, a redo with new music or a new voice
 * redraws nothing, and the chunks are joined without re-encoding.
 *
 * What makes a cached chunk safe is that the frames of a chunk are a pure function of the
 * render page's code (hashed whole: any change to a composition invalidates every chunk), the
 * props, the recording frames shown and the image files. The props are hashed as the chunk
 * sees them: everything global, plus each list cut down to what can reach the chunk's time
 * (`chunkView`). Erring toward a miss is the rule: a false miss redraws two seconds, a false
 * hit would ship a wrong frame.
 */

/** Bump when anything below changes what a chunk's pixels depend on. */
export const RENDER_CACHE_VERSION = 2;

/** Seconds of video per chunk: one keyframe interval of the delivery encoding (see deliveryEncoding). */
export const CHUNK_SECONDS = 2;

export interface Chunk {
  index: number;
  /** Frames [from, to) of the whole video. */
  from: number;
  to: number;
}

export function chunksOf(totalFrames: number, fps: number): Chunk[] {
  const size = Math.max(1, Math.round(fps * CHUNK_SECONDS));
  const chunks: Chunk[] = [];
  for (let from = 0, index = 0; from < totalFrames; from += size, index++) chunks.push({ index, from, to: Math.min(totalFrames, from + size) });
  return chunks;
}

/** How far before a moment the pointer's past still shows: its fade after resting, its trail and click ripple. */
const CURSOR_BEFORE_MS = CURSOR_IDLE_MS + CURSOR_FADE_MS + 700;
/** How far ahead it shows: it fades in before it moves again. */
const CURSOR_AFTER_MS = CURSOR_FADE_MS + 300;
/** A chapter chip, a keycap or the camera's ramp reach at most this far from their own time. */
const REACH_MS = 4000;

/** The entries of `items` at or after `lo` and before `hi`, plus the last one before `lo` (what `latestAt` sees). */
function latestAndWithin<T extends { atMs: number }>(items: readonly T[], lo: number, hi: number): T[] {
  const before = items.filter((i) => i.atMs < lo).at(-1);
  return [...(before ? [before] : []), ...items.filter((i) => i.atMs >= lo && i.atMs < hi)];
}

/** Pointer points in [lo, hi], plus the one just before and just after (for the motion in between). */
function cursorWithin(points: readonly CursorPoint[], lo: number, hi: number): CursorPoint[] {
  const first = points.findIndex((p) => p.t >= lo);
  if (first < 0) return points.slice(-1);
  let last = first;
  while (last < points.length && (points[last] as CursorPoint).t <= hi) last++;
  return points.slice(Math.max(0, first - 1), Math.min(points.length, last + 1));
}

/**
 * The props as the frames [from, to) can see them. Sound (voices, music, effects) is left out:
 * it is mixed separately. File sources are left out too: their contents are hashed instead.
 */
export function chunkView(props: RenderProps, chunk: Chunk): unknown {
  const ms = (frame: number) => (frame * 1000) / props.fps;
  const lo = ms(chunk.from);
  const hi = ms(chunk.to);
  const { audio: _a, music: _m, sfx: _s, focus, cursor, cuts, sections, urls, keys, captions, recording, brand, hero: _h, ...global } = props;
  const rStart = recording.startMs;
  const rLo = lo - rStart;
  const rHi = hi - rStart;

  // The camera: the shot groups near this time (grouped from every window, so the grouping is
  // exact), each with when its neighbours end and start, which shortens its ramps.
  const groups = mergeFocusWindows(focus, 1200, cuts ?? []);
  const shots = groups.flatMap((g, i) => {
    const start = (g[0]?.startMs ?? 0) - REACH_MS;
    const end = (g[g.length - 1]?.endMs ?? 0) + REACH_MS;
    if (end < rLo || start > rHi) return [];
    return [{ windows: g, prevEnd: groups[i - 1]?.at(-1)?.endMs ?? null, nextStart: groups[i + 1]?.[0]?.startMs ?? null }];
  });

  // The recording frames shown, through the edit.
  const first = Math.max(0, Math.round((rStart / 1000) * props.fps));
  const count = Math.max(1, Math.round((recording.durationMs / 1000) * props.fps));
  // In frames, exactly as the composition places the recording's sequence.
  const onRecording = chunk.to > first && chunk.from < first + count;
  const frames: number[] = [];
  for (let f = Math.max(chunk.from, first); f < Math.min(chunk.to, first + count); f++) frames.push(sourceFrame(recording.timeMap, f - first, props.fps));

  return {
    ...global,
    // Where in the video: the title cards animate by their own time, so two chunks of a card differ.
    frames: [chunk.from, chunk.to],
    brand: { ...brand, logo: brand.logo ? "(file)" : null },
    hero: props.hero ? "(file)" : null,
    recording: { startMs: recording.startMs, durationMs: recording.durationMs, viewport: recording.viewport, frames },
    captions: { ...captions, cues: captions.cues.filter((c) => c.endMs > lo && c.startMs < hi) },
    ...(onRecording
      ? {
          shots,
          cursor: cursorWithin(cursor, rLo - CURSOR_BEFORE_MS, rHi + CURSOR_AFTER_MS),
          sections: latestAndWithin(sections, rLo, rHi),
          urls: latestAndWithin(urls, rLo, rHi),
          keys: latestAndWithin(keys ?? [], rLo, rHi),
        }
      : {}),
  };
}

/** The key of a chunk: its view of the props, plus the hashes of the page's code and of the files it shows. */
export function chunkKey(props: RenderProps, chunk: Chunk, inputs: { page: string; files: string; encoding: readonly string[] }): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: RENDER_CACHE_VERSION, ...inputs, size: [props.width, props.height, props.fps], view: chunkView(props, chunk) }))
    .digest("hex");
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The hash of a file's contents, read as a stream (recordings are large). */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** How much the render cache may hold (APP_STORY_RENDER_CACHE_MB, default 2048; 0 turns it off). */
export function renderCacheLimitBytes(): number {
  const mb = Number(process.env.APP_STORY_RENDER_CACHE_MB ?? 2048);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 0;
}

/** Mark a cached chunk as just used, so pruning keeps it. */
export async function touch(file: string): Promise<void> {
  const now = new Date();
  await utimes(file, now, now).catch(() => undefined);
}

/** Delete the least recently used chunks until the cache fits its limit. */
export async function pruneRenderCache(dir: string, limitBytes: number): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((n) => n.endsWith(".mp4"))
      .map(async (n) => ({ file: join(dir, n), ...(await stat(join(dir, n)).then((s) => ({ size: s.size, used: s.mtimeMs }))) })),
  );
  files.sort((a, b) => b.used - a.used);
  let total = 0;
  for (const f of files) {
    total += f.size;
    if (total > limitBytes) await rm(f.file, { force: true });
  }
}
