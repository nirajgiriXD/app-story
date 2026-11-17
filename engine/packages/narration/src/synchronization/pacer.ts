import type { AudioClip, PlacedClip, Step } from "@app-story/contracts";

export interface PacerClock {
  now(): number;
  wait(ms: number): Promise<void>;
}

export interface PacerOptions {
  /** Pause after a line before the next one may start. */
  gapMs?: number;
  /**
   * How long after a step starts its action shows on screen (the pointer's glide before a
   * click). An anchored step starts this much before its word, so the click lands on it.
   */
  leadMs?: (step: Pick<Step, "id" | "action">) => number;
}

/**
 * Keeps the recorded take in step with the narration. Each narration segment starts
 * when its first step starts; the next segment's first step waits until the previous
 * line has been spoken. A later step of a line that is anchored to one of its words
 * waits until just before that word. The result is a recording where voice and action
 * line up without stretching audio or freezing video afterwards.
 */
export class NarrationPacer {
  private readonly byFirstStep = new Map<string, AudioClip>();
  private readonly anchored = new Map<string, { clip: string; atMs: number }>();
  private readonly startedAt = new Map<string, number>();
  private readonly gapMs: number;
  private busyUntil = 0;
  readonly placed: PlacedClip[] = [];

  constructor(
    segments: readonly AudioClip[],
    private readonly clock: PacerClock,
    private readonly options: PacerOptions = {},
  ) {
    this.gapMs = options.gapMs ?? 350;
    for (const clip of segments) {
      const first = clip.step_ids[0];
      if (clip.kind === "segment" && first) this.byFirstStep.set(first, clip);
      for (const a of clip.anchors ?? []) this.anchored.set(a.step_id, { clip: clip.id, atMs: a.at_ms });
    }
  }

  async beforeStep(step: Pick<Step, "id" | "action">): Promise<void> {
    const clip = this.byFirstStep.get(step.id);
    if (clip) {
      const wait = this.busyUntil - this.clock.now();
      if (wait > 0) await this.clock.wait(wait);
      const start = this.clock.now();
      this.placed.push({ ...clip, start_ms: start });
      this.startedAt.set(clip.id, start);
      this.busyUntil = start + clip.duration_ms + this.gapMs;
      return;
    }
    const anchor = this.anchored.get(step.id);
    const lineStart = anchor && this.startedAt.get(anchor.clip);
    if (!anchor || lineStart === undefined) return;
    // Never hurry a step: only hold back one that would land before its word.
    const wait = lineStart + anchor.atMs - (this.options.leadMs?.(step) ?? 0) - this.clock.now();
    if (wait > 0) await this.clock.wait(wait);
  }

  /** Let the last line finish, plus a short tail, before the recording stops. */
  async finish(tailMs = 1200): Promise<void> {
    const wait = this.busyUntil + tailMs - this.clock.now();
    if (wait > 0) await this.clock.wait(wait);
  }
}
