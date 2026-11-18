import { sourceFrame } from "./edit";
import type { RenderProps } from "./props";

/*
 * Where the app's recording sits in the video, in frames. The composition, the render workers
 * and the render cache all ask this one place, so they always agree on which frame is shown.
 */

export interface RecordingSpan {
  /** The first frame showing the app window: its first screen, held until `start` (see `holdMs`). */
  from: number;
  /** The frame where the take starts playing (its t = 0). */
  start: number;
  /** One past the last frame of the recording. */
  end: number;
}

export function recordingSpan(p: Pick<RenderProps, "fps" | "recording">): RecordingSpan {
  const frames = (ms: number) => Math.max(0, Math.round((ms / 1000) * p.fps));
  const start = frames(p.recording.startMs);
  return { from: Math.max(0, start - frames(p.recording.holdMs ?? 0)), start, end: start + Math.max(1, frames(p.recording.durationMs)) };
}

/** The take's frame shown at video frame `frame` (its first one while it is held). */
export function takeFrameAt(p: Pick<RenderProps, "fps" | "recording">, frame: number, span = recordingSpan(p)): number {
  return sourceFrame(p.recording.timeMap, Math.max(0, frame - span.start), p.fps);
}
