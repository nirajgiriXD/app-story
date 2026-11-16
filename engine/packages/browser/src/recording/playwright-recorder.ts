import type { Page } from "playwright";
import { runFfmpeg } from "@showrun/shared";
import type { Recorder, RecorderResult } from "./cdp-recorder";

/**
 * Fallback recorder using Playwright's built-in `recordVideo`. The context must have been
 * created with `recordVideo`; the video only becomes available after the page closes.
 */
export class PlaywrightVideoRecorder implements Recorder {
  startedAt: number;

  constructor(
    private readonly page: Page,
    pageCreatedAt: number,
    private readonly options: { width: number; height: number; fps: number },
  ) {
    this.startedAt = pageCreatedAt;
  }

  async start(): Promise<void> {
    // Playwright starts recording when the page is created.
  }

  async stop(outputPath: string): Promise<RecorderResult> {
    const stoppedAt = Date.now();
    const video = this.page.video();
    if (!video) throw new Error("Playwright video recording was not enabled for this context.");
    await this.page.close();
    const webm = await video.path();
    const { width, height, fps } = this.options;
    await runFfmpeg([
      "-i", webm,
      "-vf", `scale=${width}:${height}:flags=lanczos,fps=${fps},format=yuv420p`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart",
      outputPath,
    ]);
    return { path: outputPath, durationMs: stoppedAt - this.startedAt, frames: 0, width, height };
  }
}
