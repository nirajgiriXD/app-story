import type { Logger } from "@app-story/shared";

/**
 * The stages a job goes through, by the name its errors are recorded under, with the title the
 * terminal shows for each. Entering one is a log line with a `stage` field: the CLI's live
 * display turns it into a task line of its own (`--verbose` shows every log line instead).
 */
export const STAGE_TITLES = {
  features: "Release notes",
  plan: "Plan",
  narration: "Narration",
  recording: "Recording",
  render: "Render",
  review: "AI review",
  quality: "Quality checks",
  formats: "Delivery",
} as const;

export type Stage = keyof typeof STAGE_TITLES;

/** Log the start of `stage` (which ends the one before it). Returns the stage, to note as the job's phase. */
export function enterStage(log: Logger, stage: Stage): Stage {
  log.info({ stage }, STAGE_TITLES[stage]);
  return stage;
}

/** Log the end of the last stage: done, or failed with why. */
export function endStages(log: Logger, outcome: { ok: boolean; status?: string; error?: string }): void {
  log.info({ stage: "end", ...outcome }, outcome.ok ? "done" : "failed");
}
