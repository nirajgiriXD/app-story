import { join } from "node:path";
import type { StepResult } from "@app-story/contracts";
import type { LoginState } from "@app-story/browser";
import type { LoadedProduct } from "@app-story/products";
import { AppStoryError, createLogger, dataDirFor, isAppStoryError } from "@app-story/shared";
import { runSteps, validateWorkflow } from "@app-story/workflow";
import { withBrowser } from "../pipeline/browser";
import { listPlans, planKey, readPlan } from "../pipeline/plans";

export interface PlanCheck {
  name: string;
  ok: boolean;
  /** Every step that ran, in order. */
  steps: StepResult[];
  /** Why it failed, in plain words. */
  problems: string[];
  /** A screenshot of the page where it failed. */
  screenshot?: string;
  durationMs: number;
}

export interface TestPlansRequest {
  product: LoadedProduct;
  outputDir: string;
  /** Plans to test, by name. Default: every saved plan of the product. */
  names?: string[];
  headless?: boolean;
  logLevel?: string;
  /** Called as each plan finishes. */
  onPlan?: (check: PlanCheck) => void;
}

/**
 * Check that saved plans still work in the app: each one is replayed in a real browser at
 * full speed, every step and every expected outcome verified, without recording, voice or AI.
 * A demo is then also a test: when the app changes under it, this says which step broke and
 * why, before a video goes stale. Screenshots of failures are kept in `.app-story/tests/`.
 */
export async function testPlans(request: TestPlansRequest): Promise<PlanCheck[]> {
  const { product } = request;
  const names = request.names?.length ? request.names.map(planKey) : (await listPlans(product)).map((p) => p.name);
  if (names.length === 0) {
    throw new AppStoryError("CONFIG_INVALID", `${product.id} has no saved plans to test.`, {
      hint: `Make a video first (npx app-story ${product.id}), or import a Playwright trace: npx app-story import ${product.id} trace.zip`,
    });
  }
  const log = createLogger({ level: request.logLevel ?? "warn" });
  const checks: PlanCheck[] = [];
  let loginState: LoginState | undefined;
  for (const name of names) {
    const startedAt = Date.now();
    const check = await testOne(name).catch(
      (error: unknown): PlanCheck => ({
        name,
        ok: false,
        steps: [],
        problems: [isAppStoryError(error) ? `${error.message}${error.hint ? ` (${error.hint})` : ""}` : String((error as Error)?.message ?? error)],
        durationMs: Date.now() - startedAt,
      }),
    );
    checks.push(check);
    request.onPlan?.(check);
  }
  return checks;

  async function testOne(name: string): Promise<PlanCheck> {
    const startedAt = Date.now();
    const plan = await readPlan(product, name);
    const validation = validateWorkflow(plan, product.config);
    if (validation.errors.length > 0) return { name, ok: false, steps: [], problems: validation.errors, durationMs: Date.now() - startedAt };

    const dir = join(dataDirFor(request.outputDir), "tests", product.id, name);
    const report = await withBrowser(product, { workDir: dir, log, headless: request.headless, loginState }, async (session) => {
      loginState = session.loginState ?? loginState;
      return runSteps(session.controller, [...plan.setup, ...plan.steps], { phase: "dry_run", log, retries: 1, screenshotDir: dir });
    });
    if (plan.cleanup.length > 0) {
      await withBrowser(product, { workDir: join(dir, "cleanup"), log, headless: request.headless, loginState }, (s) =>
        runSteps(s.controller, plan.cleanup, { phase: "dry_run", log, retries: 1 }),
      ).catch((error: Error) => log.warn({ plan: name, error: error.message }, "a cleanup step failed; test data may need manual cleanup"));
    }
    const failed = report.steps.find((s) => s.status === "failed");
    const problems = failed ? [`step ${failed.step_id} (${failed.description}): ${failed.error ?? "failed"}`] : [];
    return { name, ok: report.ok, steps: report.steps, problems, screenshot: failed?.screenshot, durationMs: Date.now() - startedAt };
  }
}
