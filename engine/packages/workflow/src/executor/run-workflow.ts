import type { ExecutionReport, Step, StepResult } from "@demoforge/contracts";
import type { BrowserController } from "@demoforge/browser";
import { DemoForgeError, ensureDir, type Logger } from "@demoforge/shared";
import { executeStep } from "./execute-step";

export interface RunHooks {
  /** Called before each step; the recorder uses it to wait for narration to finish. */
  beforeStep?(step: Step, index: number): Promise<void>;
  afterStep?(step: Step, result: StepResult, index: number): Promise<void>;
}

export interface RunStepsOptions {
  phase: ExecutionReport["phase"];
  log: Logger;
  retries?: number;
  /** Minimum time each step stays on screen (presentation pacing). */
  minStepMs?: number;
  screenshotDir?: string;
  hooks?: RunHooks;
  /** Absolute wall-clock deadline (ms since epoch). */
  deadline?: number;
}

/**
 * Run steps in order. Stops at the first failed step that is not optional.
 * Returns a report; never throws for step failures (callers decide what a failure means).
 */
export async function runSteps(
  controller: BrowserController,
  steps: readonly Step[],
  options: RunStepsOptions,
): Promise<ExecutionReport> {
  const startedAt = Date.now();
  const results: StepResult[] = [];
  if (options.screenshotDir) await ensureDir(options.screenshotDir);

  let ok = true;
  for (const [index, step] of steps.entries()) {
    if (options.deadline && Date.now() > options.deadline) {
      throw new DemoForgeError("TIMEOUT", `Workflow exceeded its maximum duration at step ${step.id}.`);
    }
    await options.hooks?.beforeStep?.(step, index);
    const stepStart = Date.now();
    const result = await executeStep(controller, step, {
      retries: options.retries ?? 1,
      log: options.log,
      screenshotDir: options.screenshotDir,
    });
    results.push(result);
    if (result.status === "passed" && options.minStepMs) {
      const remaining = options.minStepMs - (Date.now() - stepStart);
      if (remaining > 0) await controller.wait(remaining);
    }
    await options.hooks?.afterStep?.(step, result, index);
    if (result.status === "failed" && !step.optional) {
      ok = false;
      break;
    }
  }

  return {
    phase: options.phase,
    ok,
    steps: results,
    cursor: [...controller.cursor],
    issues: [...controller.issues],
    final_url: controller.currentUrl(),
    duration_ms: Date.now() - startedAt,
  };
}
