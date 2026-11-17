import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AppStoryError } from "@app-story/shared";

/**
 * Where the next whole JPEG image in `buffer` (starting at `from`) ends, or -1 if it is
 * not complete yet. Walks the marker segments instead of searching for the end marker,
 * so bytes inside headers can never be mistaken for it.
 */
export function jpegEnd(buffer: Buffer, from = 0): number {
  if (buffer.length < from + 2) return -1;
  if (buffer[from] !== 0xff || buffer[from + 1] !== 0xd8) throw new Error("Not a JPEG image (no start marker).");
  let i = from + 2;
  while (i + 1 < buffer.length) {
    if (buffer[i] !== 0xff) throw new Error("Broken JPEG image (expected a marker).");
    const marker = buffer[i + 1] as number;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9) return i + 2; // end of image
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length
      continue;
    }
    if (i + 3 >= buffer.length) return -1;
    const length = buffer.readUInt16BE(i + 2);
    if (i + 2 + length > buffer.length) return -1;
    i += 2 + length;
    if (marker === 0xda) {
      // Compressed data follows: it ends at the first marker that is not a stuffed 0xFF00 or a restart marker.
      while (true) {
        if (i + 1 >= buffer.length) return -1;
        if (buffer[i] === 0xff) {
          const next = buffer[i + 1] as number;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        i++;
      }
    }
  }
  return -1;
}

/**
 * The recording's frames as JPEG images, decoded by FFmpeg at the video's frame rate and
 * read in order. A render worker asks for frame after frame of its stretch of the video;
 * asking for the same frame again, or past the end, returns the last one read.
 */
export class RecordingFrames {
  private readonly ffmpeg: ChildProcessWithoutNullStreams;
  private pending: Buffer = Buffer.alloc(0);
  private ready: Buffer[] = [];
  private ended = false;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private stderr = "";
  private index: number;
  private last: Buffer | undefined;

  /** Frames `first` to `first + count - 1` of `file`, at `fps`. */
  constructor(file: string, fps: number, first: number, count: number) {
    this.index = first - 1;
    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        // A quarter frame early: aiming at the frame's exact time can round past it and start one frame late,
        // and half a frame early makes FFmpeg's frame-rate filter choose between two frames.
        "-ss",
        (Math.max(0, first - 0.25) / fps).toFixed(4),
        "-i",
        file,
        "-frames:v",
        String(Math.max(1, count)),
        // The browser reads JPEG as full-range BT.601; convert explicitly so no colour shifts.
        "-vf",
        `fps=${fps},scale=out_color_matrix=bt601:out_range=pc,format=yuvj444p`,
        "-c:v",
        "mjpeg",
        "-q:v",
        "1",
        "-f",
        "image2pipe",
        "-",
      ],
      { windowsHide: true },
    );
    this.ffmpeg.stdout.on("data", (chunk: Buffer) => this.take(chunk));
    this.ffmpeg.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000);
    });
    this.ffmpeg.on("error", (error: NodeJS.ErrnoException) => {
      this.failure =
        error.code === "ENOENT"
          ? new AppStoryError("DEPENDENCY_MISSING", "'ffmpeg' was not found on PATH.", {
              hint: "Install FFmpeg (https://ffmpeg.org) and make sure it is on PATH.",
            })
          : error;
      this.finish();
    });
    this.ffmpeg.on("close", (code) => {
      if (code !== 0 && code !== null && !this.failure && !this.last && this.ready.length === 0) {
        this.failure = new AppStoryError("RENDER_FAILED", `ffmpeg could not read the recording: ${this.stderr.trim()}`);
      }
      this.finish();
    });
  }

  /** The image of recording frame `index`. */
  async frame(index: number): Promise<Buffer> {
    while (this.index < index) {
      const next = await this.next();
      if (!next) break;
      this.last = next;
      this.index++;
    }
    if (!this.last) throw this.failure ?? new AppStoryError("RENDER_FAILED", "The recording has no frames.");
    return this.last;
  }

  close(): void {
    this.ffmpeg.stdout.destroy();
    if (this.ffmpeg.exitCode === null) this.ffmpeg.kill();
  }

  private async next(): Promise<Buffer | undefined> {
    while (this.ready.length === 0) {
      if (this.failure) throw this.failure;
      if (this.ended) return undefined;
      // Pause FFmpeg while frames wait to be used, so a slow worker does not buffer the whole recording.
      this.ffmpeg.stdout.resume();
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    const frame = this.ready.shift();
    if (this.ready.length < 2) this.ffmpeg.stdout.resume();
    return frame;
  }

  private take(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    try {
      let end = jpegEnd(this.pending);
      while (end > 0) {
        this.ready.push(this.pending.subarray(0, end));
        this.pending = this.pending.subarray(end);
        end = jpegEnd(this.pending);
      }
    } catch (error) {
      this.failure = new AppStoryError("RENDER_FAILED", `Unreadable frame from ffmpeg: ${(error as Error).message}`);
      this.close();
    }
    if (this.ready.length >= 4) this.ffmpeg.stdout.pause();
    this.wake?.();
  }

  private finish(): void {
    this.ended = true;
    this.wake?.();
  }
}
