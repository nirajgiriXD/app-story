import { spawn } from "node:child_process";
import { ShowrunError } from "./errors";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runProcess(command: string, args: string[], options: { input?: string } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new ShowrunError("DEPENDENCY_MISSING", `'${command}' was not found on PATH.`, {
            hint: command.startsWith("ff") ? "Install FFmpeg (https://ffmpeg.org) and make sure ffmpeg and ffprobe are on PATH." : undefined,
          }),
        );
      } else reject(error);
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

export async function runFfmpeg(args: string[]): Promise<void> {
  const result = await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (result.code !== 0) {
    throw new ShowrunError("RENDER_FAILED", `ffmpeg failed: ${result.stderr.trim().slice(-800)}`);
  }
}

export interface MediaProbe {
  durationSec: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  fps?: number;
  formatName?: string;
}

interface FfprobeJson {
  format?: { duration?: string; format_name?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    duration?: string;
  }[];
}

export async function probeMedia(path: string): Promise<MediaProbe> {
  const result = await runProcess("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  if (result.code !== 0) {
    throw new ShowrunError("RENDER_FAILED", `ffprobe could not read ${path}: ${result.stderr.trim()}`);
  }
  const json = JSON.parse(result.stdout) as FfprobeJson;
  const video = json.streams?.find((s) => s.codec_type === "video");
  const audio = json.streams?.find((s) => s.codec_type === "audio");
  const [num, den] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationSec: Number(json.format?.duration ?? video?.duration ?? audio?.duration ?? 0),
    width: video?.width,
    height: video?.height,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    fps: num && den ? num / den : undefined,
    formatName: json.format?.format_name,
  };
}

/** Mean volume in dB for an audio file (silence is around -91 dB). */
export async function meanVolumeDb(path: string): Promise<number | undefined> {
  const result = await runProcess("ffmpeg", ["-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"]);
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(result.stderr);
  return match ? Number(match[1]) : undefined;
}

/** Luma range (max - min, 0-255) of the frame at `atSec`. Near 0 means a blank frame. */
export async function frameContrast(path: string, atSec: number): Promise<number | undefined> {
  const result = await runProcess("ffmpeg", [
    "-hide_banner", "-ss", atSec.toFixed(2), "-i", path, "-frames:v", "1",
    "-vf", "signalstats,metadata=print", "-f", "null", "-",
  ]);
  const min = /YMIN=(\d+(?:\.\d+)?)/.exec(result.stderr);
  const max = /YMAX=(\d+(?:\.\d+)?)/.exec(result.stderr);
  return min && max ? Number(max[1]) - Number(min[1]) : undefined;
}

export async function hasBinary(command: string): Promise<boolean> {
  try {
    const result = await runProcess(command, ["-version"]);
    return result.code === 0;
  } catch {
    return false;
  }
}
