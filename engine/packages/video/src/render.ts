import { copyFile, link, mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, openBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { AppStoryError, ensureDir, extractFrame, type Logger } from "@app-story/shared";
import type { RenderProps } from "./props";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "remotion", "index.ts");
const COMPOSITION_ID = "DemoVideo";

export interface RenderVideoOptions {
  /** Folder that every `src` in props is relative to. Only those files are handed to the renderer. */
  publicDir: string;
  props: RenderProps;
  outputFile: string;
  thumbnailFile?: string;
  /** Global time (ms) to use for the thumbnail frame. */
  thumbnailAtMs?: number;
  log: Logger;
}

let prepared: Promise<string> | undefined;

/**
 * Bundle the compositions and make sure Chrome is ready, once per process. Bundling takes
 * seconds, so the pipeline starts it at the beginning of a job and it runs while the AI
 * works. The bundle has no public folder of its own: each render stages only its files.
 */
export function prepareRenderer(): Promise<string> {
  prepared ??= (async () => {
    await ensureBrowser({ logLevel: "error" });
    const emptyPublic = await mkdtemp(join(tmpdir(), "app-story-public-"));
    return bundle({ entryPoint: ENTRY, publicDir: emptyPublic, enableCaching: true });
  })().catch((error: unknown) => {
    prepared = undefined;
    throw error;
  });
  return prepared;
}

/** One render at a time: two at once only fight over the CPU. */
let renderQueue: Promise<unknown> = Promise.resolve();

/** Render the final MP4 (H.264 + AAC) and a PNG thumbnail with Remotion. */
export function renderVideo(options: RenderVideoOptions): Promise<void> {
  const run = renderQueue.then(() => render(options));
  renderQueue = run.catch(() => undefined);
  return run;
}

async function render(options: RenderVideoOptions): Promise<void> {
  const { log } = options;
  let stageDir: string | undefined;
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  try {
    log.info("preparing the video renderer");
    const serveUrl = await prepareRenderer();
    const stage = `job-${randomUUID().slice(0, 8)}`;
    stageDir = join(serveUrl, "public", stage);
    await stageFiles(options.publicDir, stageDir, sourcesOf(options.props));
    const props: RenderProps = { ...options.props, assetBase: stage };

    // One browser for picking the composition and rendering it.
    browser = await openBrowser("chrome", { logLevel: "error" });
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps: props, logLevel: "error", puppeteerInstance: browser });
    await ensureDir(dirname(options.outputFile));

    let lastLogged = -1;
    await renderMedia({
      composition,
      serveUrl,
      puppeteerInstance: browser,
      codec: "h264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
      crf: 18,
      // Frames are captured as JPEG before encoding; Remotion's default quality (80) blurs small UI text.
      jpegQuality: 100,
      // Tag the colours so players do not shift them (untagged H.264 is often shown washed out).
      colorSpace: "bt709",
      // Remotion uses half the cores by default; rendering is the only work left at this point.
      concurrency: availableParallelism() >= 2 ? "75%" : null,
      outputLocation: options.outputFile,
      inputProps: props,
      logLevel: "error",
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 10) * 10;
        if (pct !== lastLogged) {
          lastLogged = pct;
          log.info(`rendering video ${pct}%`);
        }
      },
    });

    if (options.thumbnailFile) {
      // The thumbnail is a frame of the finished video: no second render needed.
      const lastSec = Math.max(0, composition.durationInFrames - 1) / composition.fps;
      const atSec = Math.min(lastSec, Math.max(0, (options.thumbnailAtMs ?? 0) / 1000));
      await extractFrame(options.outputFile, atSec, options.thumbnailFile);
    }
  } catch (error) {
    if (error instanceof AppStoryError) throw error;
    throw new AppStoryError("RENDER_FAILED", `Video rendering failed: ${(error as Error).message}`, { cause: error });
  } finally {
    await browser?.close({ silent: true }).catch(() => undefined);
    if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Every file the composition loads, relative to the job folder. */
function sourcesOf(props: RenderProps): string[] {
  return [props.recording.src, ...props.audio.map((a) => a.src), props.brand.logo, props.music?.src].filter((s): s is string => Boolean(s));
}

/** Put the job's files where the bundle serves them. Hard links are instant; copy across drives. */
async function stageFiles(fromDir: string, toDir: string, sources: string[]): Promise<void> {
  for (const src of new Set(sources)) {
    const from = join(fromDir, src);
    const to = join(toDir, src);
    await mkdir(dirname(to), { recursive: true });
    await link(from, to).catch(() => copyFile(from, to));
  }
}
