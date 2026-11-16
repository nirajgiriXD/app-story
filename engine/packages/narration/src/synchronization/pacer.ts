import type { AudioClip, PlacedClip, Step } from "@app-story/contracts";

export interface PacerClock {
  now(): number;
  wait(ms: number): Promise<void>;
}

/**
 * Keeps the recorded take in step with the narration. Each narration segment starts
 * when its first step starts; the next segment's first step waits until the previous
 * line has been spoken. The result is a recording where voice and action line up
 * without stretching audio or freezing video afterwards.
 */
export class NarrationPacer {
  private readonly byFirstStep = new Map<string, AudioClip>();
  private busyUntil = 0;
  readonly placed: PlacedClip[] = [];

  constructor(
    segments: readonly AudioClip[],
    private readonly clock: PacerClock,
    private readonly gapMs = 350,
  ) {
    for (const clip of segments) {
      const first = clip.step_ids[0];
      if (clip.kind === "segment" && first) this.byFirstStep.set(first, clip);
    }
  }

  async beforeStep(step: Pick<Step, "id">): Promise<void> {
    const clip = this.byFirstStep.get(step.id);
    if (!clip) return;
    const wait = this.busyUntil - this.clock.now();
    if (wait > 0) await this.clock.wait(wait);
    const start = this.clock.now();
    this.placed.push({ ...clip, start_ms: start });
    this.busyUntil = start + clip.duration_ms + this.gapMs;
  }

  /** Let the last line finish, plus a short tail, before the recording stops. */
  async finish(tailMs = 1200): Promise<void> {
    const wait = this.busyUntil + tailMs - this.clock.now();
    if (wait > 0) await this.clock.wait(wait);
  }
}
