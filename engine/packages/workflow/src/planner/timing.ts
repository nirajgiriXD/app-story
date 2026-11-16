import type { Step } from "@app-story/contracts";
import { MAX_TYPING_MS } from "@app-story/browser";

export interface StepPacing {
  minStepMs: number;
  typingDelayMs: number;
  cursorMoveMs: number;
}

/**
 * Roughly how long a step stays on screen in the recording (cursor glide, typing, the page
 * reacting). Narration uses it to size each line to its steps, so the voice and the action
 * end together instead of the screen freezing while the narrator catches up.
 */
export function estimateStepMs(step: Step, pacing: StepPacing): number {
  const glide = Math.round(pacing.cursorMoveMs * 0.8) + 120;
  let ms: number;
  switch (step.action) {
    case "navigate":
      ms = 1500;
      break;
    case "click":
      ms = glide + 600;
      break;
    case "fill":
      ms = glide + 300 + Math.min((step.value?.length ?? 0) * pacing.typingDelayMs, MAX_TYPING_MS);
      break;
    case "select":
      ms = glide + 700;
      break;
    case "check":
    case "uncheck":
      ms = glide + 400;
      break;
    case "hover":
      ms = glide + 300;
      break;
    case "scroll":
      ms = 900;
      break;
    case "press":
      ms = 500;
      break;
    case "wait":
      ms = step.duration_ms ?? 1000;
      break;
    default:
      ms = 300;
  }
  if (step.expected && step.action !== "assert") ms += 200;
  return Math.max(pacing.minStepMs, ms);
}
