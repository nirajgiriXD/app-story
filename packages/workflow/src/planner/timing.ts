import { PAGE_CHANGE_SETTLE_MS, type Step } from "@app-story/contracts";
import { MAX_TYPING_MS, MENU_OPEN_MS } from "@app-story/browser";

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
/** Steps whose action shows when the pointer arrives on their element. */
const POINTER_ACTIONS = new Set<Step["action"]>(["click", "fill", "select", "check", "uncheck", "hover"]);

/** About how long the pointer takes to glide to an element and settle before the click. */
function glideMs(pacing: Pick<StepPacing, "cursorMoveMs">): number {
  return Math.round(pacing.cursorMoveMs * 0.8) + 120;
}

/**
 * How long after a step starts its action shows on screen: the pointer's glide for a click
 * or a field, nothing for a key press or a check. A step anchored to a spoken word starts
 * this much earlier, so the click lands on the word.
 */
export function actionLeadMs(step: Pick<Step, "action">, pacing: Pick<StepPacing, "cursorMoveMs">): number {
  return POINTER_ACTIONS.has(step.action) ? glideMs(pacing) : 0;
}

export function estimateStepMs(step: Step, pacing: StepPacing): number {
  const glide = glideMs(pacing);

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
      // Open the list, glide to the option, pick it (a native dropdown is drawn by the video).
      ms = glide + MENU_OPEN_MS + 450 + 600;
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
  // A step that changes the page holds the next one while the camera pulls back and pushes in
  // again: the script writer sees that time, so the voice fills it instead of racing ahead.
  if (changesPage(step)) ms = Math.max(ms, actionLeadMs(step, pacing) + PAGE_CHANGE_SETTLE_MS);
  return Math.max(pacing.minStepMs, ms);
}

function changesPage(step: Step): boolean {
  return step.action === "navigate" || step.expected?.type === "url_contains";
}
