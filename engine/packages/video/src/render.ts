import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Route } from "playwright";
import { AppStoryError, ensureDir, extractFrame, measureLoudness, runFfmpeg, type Logger } from "@app-story/shared";
import { buildAudioMix, MASTER_LOUDNESS, masterChain } from "./audio";
import { sourceFrame } from "./edit";
import { RecordingFrames } from "./frames";
import type { RenderProps } from "./props";

/*
 * How a video is made:
 *
 * 1. The compositions (React) are bundled into one script for a render page.
 * 2. The frames are split into stretches, one per worker. Each worker has its own headless
 *    browser tab, its own FFmpeg reading the recording's frames for its stretch, and its
 *    own FFmpeg encoding what the tab shows. For every frame the tab draws the picture
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
/** Fewer frames than this per worker is not worth another browser tab. */
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
  // Each worker is a browser tab and two FFmpeg processes, so one per two cores.
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
  let browser: Browser | undefined;
  try {
    const script = await prepareRenderer();
    workDir = await mkdtemp(join(tmpdir(), "app-story-render-"));
    browser = await launchBrowser();
    const ranges = splitFrames(total, workerCount());
    log.info({ frames: total, workers: ranges.length }, "rendering video");

    let done = 0;
    let lastLogged = -1;
    const onFrame = () => {
      done++;
      const pct = Math.floor((done / total) * 10) * 10;
      if (pct !== lastLogged) {
        lastLogged = pct;
        log.info(`rendering video ${pct}%`);
      }
    };
    const parts = ranges.map((_, i) => join(workDir as string, `part-${i}.mp4`));
    const state = { failed: false };
    const b = browser;
    await Promise.all(
      ranges.map((range, i) =>
        renderRange({ browser: b, script, options, range, outFile: parts[i] as string, onFrame, state }).catch((error: unknown) => {
          state.failed = true;
          throw error;
        }),
      ),
    );

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
    await browser?.close().catch(() => undefined);
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

interface RangeJob {
  browser: Browser;
  script: string;
  options: RenderVideoOptions;
  range: [number, number];
  outFile: string;
  onFrame: () => void;
  /** Set when another worker failed, so the rest stop early. */
  state: { failed: boolean };
}

/** Draw, capture and encode frames [from, to) in one browser tab. */
async function renderRange(job: RangeJob): Promise<void> {
  const { props, publicDir } = job.options;
  const [from, to] = job.range;
  // The recording's place in frames, exactly as the composition computes it.
  const recordingFirst = Math.max(0, Math.round((props.recording.startMs / 1000) * props.fps));
  const recordingCount = Math.max(1, Math.round((props.recording.durationMs / 1000) * props.fps));
  const first = Math.max(from, recordingFirst);
  const last = Math.min(to, recordingFirst + recordingCount);
  // The take's frames this stretch shows, through the edit (exactly as the composition asks for them).
  const map = props.recording.timeMap;
  const takeFirst = sourceFrame(map, first - recordingFirst, props.fps);
  const takeLast = sourceFrame(map, last - 1 - recordingFirst, props.fps);
  const recording = last > first ? new RecordingFrames(fileIn(publicDir, props.recording.src), props.fps, takeFirst, takeLast - takeFirst + 1) : undefined;

  const context = await job.browser.newContext({ viewport: { width: props.width, height: props.height }, deviceScaleFactor: 1 });
  const encoder = new FrameEncoder(props.fps, job.outFile);
  let serveError: unknown;
  try {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      try {
        await serve(route, job, recording);
      } catch (error) {
        serveError ??= error;
        await route.abort().catch(() => undefined);
      }
    });
    await page.goto(`${ORIGIN}/`);
    await page.evaluate((p) => window.appStory.setup(p), props);
    const cdp = await context.newCDPSession(page);
    for (let frame = from; frame < to; frame++) {
      if (job.state.failed) return;
      await page.evaluate((n) => window.appStory.renderFrame(n), frame);
      if (serveError) throw serveError;
      const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 100 })) as { data: string };
      await encoder.write(Buffer.from(shot.data, "base64"));
      job.onFrame();
    }
    await encoder.finish();
  } finally {
    recording?.close();
    encoder.kill();
    await context.close().catch(() => undefined);
  }
}

/** Answer the render page's requests: the page, its script, job files and recording frames. */
async function serve(route: Route, job: RangeJob, recording: RecordingFrames | undefined): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) return route.abort();
  const { props, publicDir } = job.options;
  if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml(props) });
  if (url.pathname === "/main.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: job.script });
  const frame = /^\/recording\/(\d+)\.jpg$/.exec(url.pathname);
  if (frame) {
    if (!recording) throw new Error(`recording frame ${frame[1]} was asked for outside this worker's stretch`);
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
