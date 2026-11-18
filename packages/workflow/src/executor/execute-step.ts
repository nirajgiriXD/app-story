import { join } from "node:path";
import type { Box, Step, StepResult } from "@app-story/contracts";
import type { ActionOutcome, BrowserController } from "@app-story/browser";
import { describeTarget } from "@app-story/browser";
import { isAppStoryError, resolveEnvTemplate, sleep, toAppStoryError, type Logger } from "@app-story/shared";

export interface StepExecutionOptions {
  /** Extra attempts after the first failure (policy violations are never retried). */
  retries: number;
  log: Logger;
  /** Where to put failure screenshots. */
  screenshotDir?: string;
}

/** Describe a step for logs without leaking secret values. */
export function describeStep(step: Step): string {
  const target = step.target ? ` ${describeTarget(step.target)}` : "";
  const value = step.value === undefined ? "" : step.secret || /\{\{\s*env:/.test(step.value) ? ' "***"' : ` "${step.value}"`;
  const extra = step.url ? ` ${step.url}` : step.key ? ` ${step.key}` : "";
  return `${step.action}${target}${value}${extra}`;
}

async function performAction(controller: BrowserController, step: Step): Promise<ActionOutcome> {
  const opts = { timeoutMs: step.timeout_ms, secret: step.secret };
  switch (step.action) {
    case "navigate":
      return controller.navigate(step.url as string, opts);
    case "click":
      return controller.click(step.target!, opts);
    case "fill":
      return controller.fill(step.target!, resolveEnvTemplate(step.value ?? ""), opts);
    case "select":
      return controller.select(step.target!, resolveEnvTemplate(step.value ?? ""), opts);
    case "check":
      return controller.setChecked(step.target!, true, opts);
    case "uncheck":
      return controller.setChecked(step.target!, false, opts);
    case "hover":
      return controller.hover(step.target!, opts);
    case "scroll":
      return controller.scroll({ target: step.target, direction: step.direction, amount: step.amount });
    case "press":
      return controller.press(step.key as string, opts);
    case "wait":
      await controller.wait(step.duration_ms ?? 1000);
      return { urlAfter: controller.currentUrl() };
    case "screenshot":
    case "assert":
      return { urlAfter: controller.currentUrl() };
  }
}

/**
 * Execute one step and verify its expected outcome. A step only passes when the
 * browser confirms it; nothing is assumed.
 */
export async function executeStep(controller: BrowserController, step: Step, options: StepExecutionOptions): Promise<StepResult> {
  const started = controller.now();
  const base = { step_id: step.id, action: step.action, description: step.description, section: step.section };

  if (step.when) {
    const holds = await controller.evaluateCondition(step.when).catch(() => false);
    if (!holds) {
      options.log.info({ step: step.id }, `skipped (condition not met): ${step.description}`);
      return { ...base, status: "skipped", started_ms: started, ended_ms: controller.now(), attempts: 0, verified: false, url_after: controller.currentUrl() };
    }
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      const outcome = await performAction(controller, step);
      let verified = step.action !== "assert";
      let outcomeAt: { box?: Box; region?: Box } = {};
      if (step.expected) {
        const result = await controller.verify(step.expected, { timeoutMs: step.timeout_ms });
        if (!result.ok) {
          throw Object.assign(new Error(`Expected outcome not met: ${step.expected.description ?? step.expected.type} (${result.detail})`), {
            code: "VERIFICATION_FAILED",
          });
        }
        verified = true;
        outcomeAt = { box: result.box, region: result.region };
      }
      if (step.action === "screenshot" && options.screenshotDir) {
        await controller.screenshot(join(options.screenshotDir, `${step.id}.png`));
      }
      options.log.info({ step: step.id }, `✓ ${step.description}`);
      return {
        ...base,
        status: "passed",
        started_ms: started,
        ended_ms: controller.now(),
        attempts: attempt + 1,
        verified,
        url_after: outcome.urlAfter,
        box: outcome.box,
        // A check step has no element of its own: its area is the outcome's.
        region: outcome.region ?? (step.action === "assert" ? outcomeAt.region : undefined),
        result_box: outcomeAt.box,
        menu: outcome.menu,
      };
    } catch (error) {
      lastError = error;
      const policy = isAppStoryError(error) && (error.code === "POLICY_VIOLATION" || error.code === "APP_UNAVAILABLE");
      options.log.warn({ step: step.id, attempt: attempt + 1, error: (error as Error).message }, `step failed: ${describeStep(step)}`);
      if (policy || attempt === options.retries) break;
      await sleep(600 * (attempt + 1));
    }
  }

  const err = toAppStoryError(lastError, "WORKFLOW_FAILED");
  const code = (lastError as { code?: string } | undefined)?.code === "VERIFICATION_FAILED" ? "VERIFICATION_FAILED" : err.code;
  let screenshot: string | undefined;
  if (options.screenshotDir) {
    screenshot = await controller.screenshot(join(options.screenshotDir, `failure-${step.id}.png`)).catch(() => undefined);
  }
  return {
    ...base,
    status: "failed",
    started_ms: started,
    ended_ms: controller.now(),
    attempts: options.retries + 1,
    verified: false,
    url_after: controller.currentUrl(),
    error: err.message,
    error_code: code,
    screenshot,
  };
}
