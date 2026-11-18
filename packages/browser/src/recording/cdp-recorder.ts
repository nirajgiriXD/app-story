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
  /**
   * The size of the frames the browser really sent, before FFmpeg scaled them to
   * `width` x `height`. Smaller means the recording was stretched and is less sharp.
   */
  source?: { width: number; height: number };
}

/** The pixel size of a JPEG or PNG image, read from its header. */
export function imageSize(image: Buffer): { width: number; height: number } | undefined {
  // PNG: the IHDR chunk comes first.
  if (image.length >= 24 && image.readUInt32BE(0) === 0x89504e47) {
    return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  }
  if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8) return undefined;
  // JPEG: walk the marker segments to the frame header (SOF0-SOF15, but not DHT, JPG or DAC).
  let i = 2;
  while (i + 9 < image.length) {
    if (image[i] !== 0xff) return undefined;
    const marker = image[i + 1] as number;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: image.readUInt16BE(i + 5), width: image.readUInt16BE(i + 7) };
    }
    i += 2 + image.readUInt16BE(i + 2);
  }
  return undefined;
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
  private source: { width: number; height: number } | undefined;

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
      const image = Buffer.from(event.data, "base64");
      if (index === 0) this.source = imageSize(image);
      this.writes.push(writeFile(file, image));
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
    // The last image is listed twice (older FFmpeg needs it to show its duration), and newer
    // FFmpeg then shows it for that duration again: cut the file to the take's exact length.
    const seconds = ((stoppedAt - this.startedAt) / 1000).toFixed(3);
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", listFile, ...intermediateVideoArgs(width, height, fps), "-t", seconds, outputPath]);
    await rm(this.framesDir, { recursive: true, force: true });
    this.options.log.debug({ frames: frames.length, source: this.source }, "screen recording encoded");
    if (this.source && (this.source.width < width || this.source.height < height)) {
      this.options.log.warn({ sent: this.source, stored: { width, height } }, "the browser sent smaller frames than asked for: the recording is stretched");
    }
    return { path: outputPath, durationMs: stoppedAt - this.startedAt, frames: frames.length, width, height, source: this.source };
  }
}
