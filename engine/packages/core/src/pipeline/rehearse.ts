import { join } from "node:path";
import type { VideoKind, Workflow } from "@showrun/contracts";
import { runRehearsal, type ProductContext, type RehearsalOutcome } from "@showrun/ai";
import type { LoadedProduct } from "@showrun/products";
import { ShowrunError, type ErrorCode } from "@showrun/shared";
import { saveRecord, type Job } from "../job-manager/job";
import { withBrowser } from "./browser";
import { withProviderFallback, type ProviderOverrides } from "./providers";

/** What the AI knows about the product: its name, address and the product file's text. */
export function productContext(product: LoadedProduct): ProductContext {
  return {
    name: product.config.product.name,
    description: product.config.product.description,
    baseUrl: product.config.product.base_url,
    brief: product.brief,
  };
}

export interface RehearseOptions {
  objective: string;
  audience?: string;
  kind?: VideoKind;
  durationS: number;
  headless?: boolean;
}

const GIVE_UP_CODES: Record<Extract<RehearsalOutcome, { status: "gave_up" }>["category"], ErrorCode> = {
  unsupported: "UNSUPPORTED_WORKFLOW",
  blocked_by_policy: "UNSUPPORTED_WORKFLOW",
  application_error: "APP_UNAVAILABLE",
  authentication: "AUTH_FAILED",
  other: "WORKFLOW_FAILED",
};

/**
 * Practice run: the AI explores and verifies the flow in an unrecorded browser and
 * returns a clean workflow (a click-plan). The practice run is kept in the database.
 */
export async function rehearseWorkflow(
  job: Job,
  product: LoadedProduct,
  options: RehearseOptions,
  overrides: ProviderOverrides,
): Promise<Workflow> {
  const config = product.config;
  const outcome = await withProviderFallback(job, "rehearsal", config, overrides, (provider) =>
    withBrowser(
      product,
      { workDir: join(job.paths.logsDir, "rehearsal-browser"), log: job.log, headless: options.headless },
      (session) =>
        runRehearsal({
          provider,
          controller: session.controller,
          product: productContext(product),
          objective: options.objective,
          audience: options.audience,
          kind: options.kind,
          targetDurationS: options.durationS,
          maxIterations: config.providers.ai.max_iterations,
          maxDurationS: config.providers.ai.max_duration_s,
          log: job.log,
          screenshotDir: join(job.paths.logsDir, "rehearsal-screenshots"),
          jobId: job.id,
        }),
    ),
  );
  saveRecord(job, "rehearsal", outcome);

  if (outcome.status === "success") {
    job.log.info({ steps: outcome.workflow.steps.length, iterations: outcome.iterations }, "rehearsal succeeded");
    return outcome.workflow;
  }
  if (outcome.status === "gave_up") {
    throw new ShowrunError(GIVE_UP_CODES[outcome.category], `The AI agent could not complete the demo: ${outcome.reason}`);
  }
  const failed = outcome.report.steps.filter((s) => s.status === "failed").slice(-1)[0];
  throw new ShowrunError("WORKFLOW_FAILED", `${outcome.reason}${failed ? ` Last error: ${failed.error}` : ""}`);
}
