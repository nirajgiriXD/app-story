import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { DemoForgeError, ensureDir, type Logger } from "@demoforge/shared";
import type { RenderProps } from "./props";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "remotion", "index.ts");
const COMPOSITION_ID = "DemoVideo";

export interface RenderVideoOptions {
  /** Folder served as Remotion's public dir; every `src` in props is relative to it. */
  publicDir: string;
  props: RenderProps;
  outputFile: string;
  thumbnailFile?: string;
  /** Global time (ms) to use for the thumbnail frame. */
  thumbnailAtMs?: number;
  log: Logger;
}

/** Render the final MP4 (H.264 + AAC) and a PNG thumbnail with Remotion. */
export async function renderVideo(options: RenderVideoOptions): Promise<void> {
  const { log, props } = options;
  try {
    await ensureBrowser({ logLevel: "error" });
    log.info("bundling video composition");
    const serveUrl = await bundle({ entryPoint: ENTRY, publicDir: options.publicDir, enableCaching: true });
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps: props, logLevel: "error" });
    await ensureDir(dirname(options.outputFile));

    let lastLogged = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
      crf: 18,
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
      const frame = Math.min(
        composition.durationInFrames - 1,
        Math.max(0, Math.round(((options.thumbnailAtMs ?? 0) / 1000) * composition.fps)),
      );
      await renderStill({ composition, serveUrl, output: options.thumbnailFile, frame, inputProps: props, imageFormat: "png", logLevel: "error" });
    }
  } catch (error) {
    if (error instanceof DemoForgeError) throw error;
    throw new DemoForgeError("RENDER_FAILED", `Video rendering failed: ${(error as Error).message}`, { cause: error });
  }
}
