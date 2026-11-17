import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright";
import { ensureDir, runFfmpeg, type Logger } from "@app-story/shared";

export interface RecorderResult {
  path: string;
  durationMs: number;
  frames: number;
  width: number;
  height: number;
}

export interface Recorder {
  /** Wall-clock time (ms since epoch) that maps to t=0 in the output video. */
  readonly startedAt: number;
  start(): Promise<void>;
  stop(outputPath: string): Promise<RecorderResult>;
}

/**
 * FFmpeg output options for the intermediate recording. It is only read once more, by the
 * renderer, so it is stored lossless (no second round of compression on small UI text) and
 * with full colour detail (4:4:4), which `ultrafast` also encodes several times faster than
 * a compressed `medium` encode. Colours are converted and tagged as BT.709, which is what
 * the final video uses, so nothing shifts between the browser and the MP4.
 */
export function intermediateVideoArgs(width: number, height: number, fps: number): string[] {
  return [
    "-vf",
    `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,fps=${fps},format=yuv444p`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-qp",
    "0",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
  ];
}

interface Frame {
  file: string;
  /** When the frame arrived here (Node's clock, epoch ms). */
  receivedAt: number;
  /** When Chromium drew it (Chromium's clock, epoch ms), if it said. */
  drawnAt?: number;
}

/**
 * Frame times on Node's clock, the one the steps and the cursor use. Chromium's own frame
 * times are more exact (no transport delay) but its clock can be seconds away from Node's,
 * so they are shifted by the smallest delay seen: a frame can never arrive before it is drawn.
 */
export function frameTimes(frames: readonly { receivedAt: number; drawnAt?: number }[]): number[] {
  let offset = Number.POSITIVE_INFINITY;
  for (const f of frames) if (f.drawnAt !== undefined) offset = Math.min(offset, f.receivedAt - f.drawnAt);
  let last = Number.NEGATIVE_INFINITY;
  return frames.map((f) => {
    const t = f.drawnAt !== undefined && Number.isFinite(offset) ? f.drawnAt + offset : f.receivedAt;
    last = Math.max(last, t);
    return last;
  });
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
  metadata: { timestamp?: number };
}

/**
 * Records a page by streaming frames from Chromium (CDP `Page.startScreencast`) and
 * encoding them with FFmpeg. Frames are lossless-ish JPEGs at the viewport's real size,
 * which keeps small UI text sharp, unlike Playwright's fixed-bitrate VP8 recorder.
 *
 * Chromium only sends a frame when the screen changes, so each frame is held until the
 * next one arrives; FFmpeg then resamples to a constant frame rate.
 */
export class CdpScreencastRecorder implements Recorder {
  startedAt = 0;
  private session: CDPSession | undefined;
  private frames: Frame[] = [];
  private writes: Promise<void>[] = [];
  private framesDir: string;

  constructor(
    private readonly page: Page,
    workDir: string,
    private readonly options: { width: number; height: number; fps: number; quality: number; log: Logger },
  ) {
    this.framesDir = join(workDir, "frames");
  }

  async start(): Promise<void> {
    await ensureDir(this.framesDir);
    this.session = await this.page.context().newCDPSession(this.page);
    this.session.on("Page.screencastFrame", (event: ScreencastFrameEvent) => {
      const index = this.frames.length;
      const file = join(this.framesDir, `${String(index).padStart(6, "0")}.jpg`);
      const drawnAt = event.metadata.timestamp ? event.metadata.timestamp * 1000 : undefined;
      this.frames.push({ file, receivedAt: Date.now(), drawnAt });
      this.writes.push(writeFile(file, Buffer.from(event.data, "base64")));
      this.session?.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
    });
    this.startedAt = Date.now();
    await this.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.options.quality,
      maxWidth: this.options.width,
      maxHeight: this.options.height,
      everyNthFrame: 1,
    });
  }

  async stop(outputPath: string): Promise<RecorderResult> {
    const stoppedAt = Date.now();
    await this.session?.send("Page.stopScreencast").catch(() => undefined);
    await this.session?.detach().catch(() => undefined);
    await Promise.all(this.writes);
    if (this.frames.length === 0) throw new Error("The screen recorder captured no frames.");

    // Build an FFmpeg concat list where each frame lasts until the next one.
    const lines: string[] = ["ffconcat version 1.0"];
    const frames = this.frames;
    const times = frameTimes(frames);
    // Each frame is shown from its time until the next frame's; the first from the start.
    // Ends are rounded to the millisecond on one running clock, so the parts add up to the take exactly.
    let shownUntil = this.startedAt;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i] as Frame;
      const next = i + 1 < frames.length ? Math.min(times[i + 1] as number, stoppedAt) : stoppedAt;
      const until = Math.max(shownUntil, next);
      // A frame replaced in the same instant is never seen.
      if (until > shownUntil || (i === frames.length - 1 && lines.length === 1)) {
        lines.push(`file '${frame.file.replace(/\\/g, "/")}'`, `duration ${Math.max(0.001, (until - shownUntil) / 1000).toFixed(4)}`);
      }
      shownUntil = until;
    }
    lines.push(`file '${(frames[frames.length - 1] as Frame).file.replace(/\\/g, "/")}'`);
    const listFile = join(this.framesDir, "frames.ffconcat");
    await writeFile(listFile, lines.join("\n"), "utf8");

    const { width, height, fps } = this.options;
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", listFile, ...intermediateVideoArgs(width, height, fps), outputPath]);
    await rm(this.framesDir, { recursive: true, force: true });
    this.options.log.debug({ frames: frames.length }, "screen recording encoded");
    return { path: outputPath, durationMs: stoppedAt - this.startedAt, frames: frames.length, width, height };
  }
}
