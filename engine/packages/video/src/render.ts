import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Route } from "playwright";
import { AppStoryError, ensureDir, extractFrame, measureLoudness, runFfmpeg, type Logger } from "@app-story/shared";
import { buildAudioMix, MASTER_LOUDNESS, masterChain } from "./audio";
import { sourceFrame } from "./edit";
import { RecordingFrames } from "./frames";
import type { RenderProps } from "./props";
import { chunkKey, chunksOf, hashFile, pruneRenderCache, renderCacheLimitBytes, sha256, touch, type Chunk } from "./render-cache";

/*
 * How a video is made:
 *
 * 1. The compositions (React) are bundled into one script for a render page.
 * 2. The frames are split into stretches, one per worker. Each worker has its own headless
 *    browser, its own FFmpeg reading the recording's frames for its stretch, and its own
 *    FFmpeg encoding what the browser shows. (Tabs of one shared browser are slower: they
 *    paint and capture through the same browser process, which then becomes the bottleneck.) For every frame the tab draws the picture
 *    (title cards, the app window with the recording, zoom, cursor, captions) and is
 *    captured.
 * 3. FFmpeg joins the stretches without re-encoding and adds the sound (see audio.ts).
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "page", "main.tsx");
/** The published package ships the render page already bundled, next to its code. */
const PREBUILT = join(here, "render-page.js");
/** The render page's made-up address. Nothing is fetched from the network: every request is answered below. */
const ORIGIN = "http://render.app-story.local";
/** Fewer frames than this per worker is not worth another browser. */
const MIN_FRAMES_PER_WORKER = 90;

export interface RenderVideoOptions {
  /** Folder that every `src` in props is relative to. Only files inside it are served to the page. */
  publicDir: string;
  props: RenderProps;
  outputFile: string;
  thumbnailFile?: string;
  /** Global time (ms) to use for the thumbnail frame. */
  thumbnailAtMs?: number;
  log: Logger;
  /**
   * Where drawn chunks are kept for reuse (see render-cache.ts). Without it, or with
   * APP_STORY_RENDER_CACHE_MB=0, every frame is drawn.
   */
  cacheDir?: string;
}

let prepared: Promise<string> | undefined;

/** Bundle the render page's script, once per process. The pipeline starts it early, while the AI works. */
export function prepareRenderer(): Promise<string> {
  prepared ??= (existsSync(PREBUILT) ? readFile(PREBUILT, "utf8") : bundleRenderPage()).catch((error: unknown) => {
    prepared = undefined;
    throw error;
  });
  return prepared;
}

/** The render page's script: the compositions (React) bundled for the browser. */
export async function bundleRenderPage(): Promise<string> {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const script = result.outputFiles[0]?.text;
  if (!script) throw new Error("bundling the render page produced no script");
  return script;
}

/** Frames in the whole video. */
export function frameCount(props: RenderProps): number {
  return Math.max(1, Math.round((props.durationMs / 1000) * props.fps));
}

/** Split frames 0..total-1 into contiguous [from, to) stretches, one per worker. */
export function splitFrames(total: number, workers: number): [number, number][] {
  const count = Math.max(1, Math.min(workers, Math.ceil(total / MIN_FRAMES_PER_WORKER)));
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.round((total * i) / count);
    const to = Math.round((total * (i + 1)) / count);
    if (to > from) ranges.push([from, to]);
  }
  return ranges;
}

function workerCount(): number {
  const fromEnv = Number(process.env.APP_STORY_RENDER_WORKERS);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  // Each worker is a browser and two FFmpeg processes, so one per two cores.
  return Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
}

/**
 * Render the final MP4 (H.264 + AAC) and a PNG thumbnail. It uses every worker it is given,
 * so callers run one render at a time (the pipeline does, through `exclusive()` in core).
 */
export async function renderVideo(options: RenderVideoOptions): Promise<void> {
  const { props, log } = options;
  const total = frameCount(props);
  let workDir: string | undefined;
  try {
    const script = await prepareRenderer();
    workDir = await mkdtemp(join(tmpdir(), "app-story-render-"));
    const chunks = chunksOf(total, props.fps);
    const limit = renderCacheLimitBytes();
    const cacheDir = options.cacheDir && limit > 0 ? options.cacheDir : undefined;
    // Each chunk's file: in the cache under its key (drawn only if missing), or in the scratch folder.
    const fileOf = new Map<number, string>();
    let todo: Chunk[] = chunks;
    if (cacheDir) {
      await ensureDir(cacheDir);
      const inputs = { page: sha256(script), files: await filesHash(options), encoding: deliveryEncoding(props.fps) };
      todo = [];
      for (const chunk of chunks) {
        const file = join(cacheDir, `${chunkKey(props, chunk, inputs)}.mp4`);
        fileOf.set(chunk.index, file);
        if (existsSync(file)) await touch(file);
        else todo.push(chunk);
      }
    } else {
      for (const chunk of chunks) fileOf.set(chunk.index, join(workDir, `chunk-${chunk.index}.mp4`));
    }
    const toDraw = todo.reduce((sum, c) => sum + c.to - c.from, 0);
    const groups = splitChunks(todo, workerCount());
    log.info({ frames: total, toDraw, reused: total - toDraw, workers: groups.length }, "rendering video");

    let done = 0;
    let lastLogged = -1;
    const onFrame = () => {
      done++;
      const pct = Math.floor((done / Math.max(1, toDraw)) * 10) * 10;
      if (pct !== lastLogged) {
        lastLogged = pct;
        log.info(`rendering video ${pct}%`);
      }
    };
    const state = { failed: false };
    await Promise.all(
      groups.map((group) =>
        renderChunks({ script, options, chunks: group, fileOf: (c) => fileOf.get(c.index) as string, onFrame, state }).catch((error: unknown) => {
          state.failed = true;
          throw error;
        }),
      ),
    );
    const parts = chunks.map((c) => fileOf.get(c.index) as string);

    await ensureDir(dirname(options.outputFile));
    const list = join(workDir, "parts.ffconcat");
    await writeFile(list, ["ffconcat version 1.0", ...parts.map((p) => `file '${p.replace(/\\/g, "/")}'`)].join("\n"), "utf8");
    // The sound: every clip and the music mixed, then mastered to one loudness for the whole video.
    const duration = (total / props.fps).toFixed(3);
    const mix = join(workDir, "mix.wav");
    const audio = buildAudioMix(props, 0, (src) => fileIn(options.publicDir, src));
    await runFfmpeg([...audio.inputArgs, "-filter_complex", audio.filter, "-map", "[aout]", "-c:a", "pcm_f32le", "-t", duration, mix]);
    const measured = await measureLoudness(mix, MASTER_LOUDNESS).catch((error: Error) => {
      log.warn({ error: error.message }, "could not measure the mix; its loudness is left as it is");
      return undefined;
    });
    await runFfmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-i",
      mix,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-af",
      masterChain(measured),
      "-c:v",
      "copy",
      // Joining the parts drops their BT.709 colour tags; write them back so players do not shift the colours.
      "-bsf:v",
      "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-t",
      duration,
      "-movflags",
      "+faststart",
      options.outputFile,
    ]);

    if (cacheDir) await pruneRenderCache(cacheDir, limit).catch((error: Error) => log.warn({ error: error.message }, "could not prune the render cache"));

    if (options.thumbnailFile) {
      // The thumbnail is a frame of the finished video: no second render needed.
      const lastSec = (total - 1) / props.fps;
      const atSec = Math.min(lastSec, Math.max(0, (options.thumbnailAtMs ?? 0) / 1000));
      await extractFrame(options.outputFile, atSec, options.thumbnailFile);
    }
  } catch (error) {
    if (error instanceof AppStoryError) throw error;
    throw new AppStoryError("RENDER_FAILED", `Video rendering failed: ${(error as Error).message}`, { cause: error });
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function launchBrowser(): Promise<Browser> {
  try {
    // sRGB everywhere, so colours match the recording and other players.
    return await chromium.launch({ headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
  } catch (error) {
    if (/Executable doesn't exist|playwright install/i.test((error as Error).message)) {
      throw new AppStoryError("DEPENDENCY_MISSING", "The browser for rendering videos is not installed.", {
        hint: "Run: npx playwright install chromium",
        cause: error,
      });
    }
    throw error;
  }
}

/** Split the chunks to draw into at most `workers` runs of neighbouring chunks, each worth a browser of its own. */
export function splitChunks(chunks: readonly Chunk[], workers: number): Chunk[][] {
  const frames = chunks.reduce((sum, c) => sum + c.to - c.from, 0);
  const count = Math.max(1, Math.min(workers, chunks.length, Math.ceil(frames / MIN_FRAMES_PER_WORKER)));
  const groups: Chunk[][] = [];
  for (let i = 0; i < count; i++) {
    const group = chunks.slice(Math.round((chunks.length * i) / count), Math.round((chunks.length * (i + 1)) / count));
    if (group.length) groups.push(group);
  }
  return groups;
}

/** The hash of the files a frame can show: the recording, the logo and the intro's still. */
async function filesHash(options: RenderVideoOptions): Promise<string> {
  const { props, publicDir } = options;
  const files = [props.recording.src, props.brand.logo, props.hero].map((src) => (src ? hashFile(fileIn(publicDir, src)) : Promise.resolve(null)));
  return sha256(JSON.stringify(await Promise.all(files)));
}

interface ChunksJob {
  script: string;
  options: RenderVideoOptions;
  chunks: Chunk[];
  /** Where each chunk's video goes. */
  fileOf: (chunk: Chunk) => string;
  onFrame: () => void;
  /** Set when another worker failed, so the rest stop early. */
  state: { failed: boolean };
}

/** The recording's frames a stretch of the video shows, read in order (or nothing, before and after the recording). */
function recordingFramesFor(props: RenderProps, publicDir: string, from: number, to: number): RecordingFrames | undefined {
  // The recording's place in frames, exactly as the composition computes it.
  const recordingFirst = Math.max(0, Math.round((props.recording.startMs / 1000) * props.fps));
  const recordingCount = Math.max(1, Math.round((props.recording.durationMs / 1000) * props.fps));
  const first = Math.max(from, recordingFirst);
  const last = Math.min(to, recordingFirst + recordingCount);
  if (last <= first) return undefined;
  // The take's frames this stretch shows, through the edit (exactly as the composition asks for them).
  const map = props.recording.timeMap;
  const takeFirst = sourceFrame(map, first - recordingFirst, props.fps);
  const takeLast = sourceFrame(map, last - 1 - recordingFirst, props.fps);
  return new RecordingFrames(fileIn(publicDir, props.recording.src), props.fps, takeFirst, takeLast - takeFirst + 1);
}

/**
 * Draw, capture and encode chunks in a browser of its own, each chunk to its own file. A
 * run of neighbouring chunks shares one reader of the recording. A chunk is written next to
 * its file and renamed into place once complete, so a cached chunk is never half written.
 */
async function renderChunks(job: ChunksJob): Promise<void> {
  if (job.chunks.length === 0) return;
  const { props, publicDir } = job.options;
  const holder: { recording?: RecordingFrames } = {};
  let browser: Browser | undefined;
  let encoder: FrameEncoder | undefined;
  let partial: string | undefined;
  let serveError: unknown;
  try {
    browser = await launchBrowser();
    if (job.state.failed) return;
    const context = await browser.newContext({ viewport: { width: props.width, height: props.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      try {
        await serve(route, job, holder.recording);
      } catch (error) {
        serveError ??= error;
        await route.abort().catch(() => undefined);
      }
    });
    await page.goto(`${ORIGIN}/`);
    await page.evaluate((p) => window.appStory.setup(p), props);
    const cdp = await context.newCDPSession(page);
    for (const [i, chunk] of job.chunks.entries()) {
      // The start of a run of neighbouring chunks: read the recording from there.
      if (i === 0 || (job.chunks[i - 1] as Chunk).index !== chunk.index - 1) {
        holder.recording?.close();
        let end = i;
        while (end + 1 < job.chunks.length && (job.chunks[end + 1] as Chunk).index === (job.chunks[end] as Chunk).index + 1) end++;
        holder.recording = recordingFramesFor(props, publicDir, chunk.from, (job.chunks[end] as Chunk).to);
      }
      const file = job.fileOf(chunk);
      partial = `${file}.${process.pid}.part`;
      encoder = new FrameEncoder(props.fps, partial);
      for (let frame = chunk.from; frame < chunk.to; frame++) {
        if (job.state.failed) return;
        await page.evaluate((n) => window.appStory.renderFrame(n), frame);
        if (serveError) throw serveError;
        const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 100 })) as { data: string };
        await encoder.write(Buffer.from(shot.data, "base64"));
        job.onFrame();
      }
      await encoder.finish();
      encoder = undefined;
      // Another job may have stored the same chunk meanwhile: then this copy is not needed.
      if (existsSync(file)) await rm(partial, { force: true });
      else await rename(partial, file);
      partial = undefined;
    }
  } finally {
    holder.recording?.close();
    encoder?.kill();
    // A chunk cut short is never left in the cache.
    if (partial) await rm(partial, { force: true }).catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

/** Answer the render page's requests: the page, its script, job files and recording frames. */
async function serve(route: Route, job: Pick<ChunksJob, "script" | "options">, recording: RecordingFrames | undefined): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) return route.abort();
  const { props, publicDir } = job.options;
  if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml(props) });
  if (url.pathname === "/main.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: job.script });
  const frame = /^\/recording\/(\d+)\.jpg$/.exec(url.pathname);
  if (frame) {
    if (!recording) throw new Error(`recording frame ${frame[1]} was asked for outside this worker's chunks`);
    return route.fulfill({ contentType: "image/jpeg", body: await recording.frame(Number(frame[1])) });
  }
  if (url.pathname.startsWith("/files/")) {
    const src = url.pathname.slice("/files/".length).split("/").map(decodeURIComponent).join("/");
    return route.fulfill({ path: fileIn(publicDir, src) });
  }
  return route.abort();
}

function pageHtml(props: RenderProps): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0;overflow:hidden}#root{position:relative;width:${props.width}px;height:${props.height}px;overflow:hidden}</style>`,
    '</head><body><div id="root"></div><script src="/main.js"></script></body></html>',
  ].join("");
}

/** A job file by its `src`; never anything outside the job folder. */
function fileIn(publicDir: string, src: string): string {
  const base = resolve(publicDir);
  const file = resolve(base, src);
  if (!file.startsWith(base + sep)) throw new Error(`'${src}' is outside the job folder`);
  return file;
}

/**
 * H.264 settings for the finished video, tuned for screen content: small UI text and flat
 * colours. `slow` and a lower CRF keep edges crisp; aq-mode 3 spends bits on dark, flat
 * areas (no blocky gradients); light deblocking keeps text sharp. A keyframe every two
 * seconds keeps seeking quick in players. High profile plays everywhere.
 */
export function deliveryEncoding(fps: number): string[] {
  return [
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "16",
    "-profile:v",
    "high",
    "-g",
    String(Math.round(fps * 2)),
    "-x264-params",
    "aq-mode=3:deblock=-1,-1",
  ];
}

/**
 * Encodes captured frames (JPEG) to H.264 as they arrive. The page is captured in sRGB,
 * which JPEG stores as full-range BT.601; the video is tagged BT.709, like the recording,
 * so players show the same colours.
 */
class FrameEncoder {
  private readonly ffmpeg;
  private readonly closed: Promise<number>;
  private stderr = "";
  private failure: Error | undefined;

  constructor(fps: number, outFile: string) {
    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "image2pipe",
        "-framerate",
        String(fps),
        "-c:v",
        "mjpeg",
        "-i",
        "-",
        "-vf",
        "scale=in_color_matrix=bt601:in_range=pc:out_color_matrix=bt709:out_range=tv,format=yuv420p",
        ...deliveryEncoding(fps),
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-f",
        "mp4",
        outFile,
      ],
      { windowsHide: true },
    );
    this.ffmpeg.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000);
    });
    this.ffmpeg.stdin.on("error", (error: Error) => {
      this.failure ??= error;
    });
    this.closed = new Promise((resolveClosed) => {
      this.ffmpeg.on("error", (error: NodeJS.ErrnoException) => {
        this.failure ??=
          error.code === "ENOENT"
            ? new AppStoryError("DEPENDENCY_MISSING", "'ffmpeg' was not found on PATH.", {
                hint: "Install FFmpeg (https://ffmpeg.org) and make sure it is on PATH.",
              })
            : error;
        resolveClosed(-1);
      });
      this.ffmpeg.on("close", (code) => resolveClosed(code ?? -1));
    });
  }

  async write(image: Buffer): Promise<void> {
    if (this.failure) throw this.encoderError();
    if (!this.ffmpeg.stdin.write(image)) await Promise.race([once(this.ffmpeg.stdin, "drain"), this.closed]);
    if (this.failure) throw this.encoderError();
  }

  async finish(): Promise<void> {
    this.ffmpeg.stdin.end();
    const code = await this.closed;
    if (code !== 0 || this.failure) throw this.encoderError();
  }

  kill(): void {
    if (this.ffmpeg.exitCode === null) this.ffmpeg.kill();
  }

  private encoderError(): Error {
    if (this.failure instanceof AppStoryError) return this.failure;
    return new AppStoryError("RENDER_FAILED", `ffmpeg could not encode the video: ${this.stderr.trim() || this.failure?.message || "unknown error"}`);
  }
}
