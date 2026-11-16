import { join } from "node:path";
import type { ExecutionReport, JobMetadata, Workflow } from "@demoforge/contracts";
import { WORKFLOW_VERSION } from "@demoforge/contracts";
import { loadScenario, type LoadedProduct } from "@demoforge/products";
import { runSteps, validateWorkflow } from "@demoforge/workflow";
import { DemoForgeError, slugify, writeJson } from "@demoforge/shared";
import { createJob, finishJob, recordError, type Job } from "../job-manager/job";
import { withBrowser } from "../pipeline/browser";
import type { ProviderOverrides } from "../pipeline/providers";
import { rehearseWorkflow } from "../pipeline/rehearse";
import { statusForError } from "../pipeline/status";

export interface DryRunRequest {
  product: LoadedProduct;
  outputDir: string;
  scenarioId?: string;
  objective?: string;
  headless?: boolean;
  logLevel?: string;
  providers?: ProviderOverrides;
  onJobCreated?: (job: Job) => void;
}

export interface DryRunResult {
  metadata: JobMetadata;
  workflow?: Workflow;
  report?: ExecutionReport;
  validation?: { errors: string[]; warnings: string[] };
}

/**
 * Preview a workflow without narration, recording or rendering. A scenario is replayed
 * step by step; an objective is rehearsed by the AI and the resulting plan is shown.
 */
export async function dryRun(request: DryRunRequest): Promise<DryRunResult> {
  const { product } = request;
  if (!request.objective === !request.scenarioId) {
    throw new DemoForgeError("CONFIG_INVALID", "Provide either an objective or a scenario.");
  }
  const job = await createJob({
    outputDir: request.outputDir,
    productId: product.id,
    name: `dry-run-${request.scenarioId ?? slugify(request.objective as string)}`,
    mode: "dry_run",
    objective: request.objective ?? null,
    scenarioId: request.scenarioId ?? null,
    logLevel: request.logLevel,
  });
  request.onJobCreated?.(job);
  try {
    let workflow: Workflow;
    let report: ExecutionReport | undefined;
    if (request.scenarioId) {
      workflow = await loadScenario(product, request.scenarioId);
      const validation = validateWorkflow(workflow, product.config);
      if (validation.errors.length) {
        job.metadata.warnings.push(...validation.warnings);
        throw new DemoForgeError("UNSUPPORTED_WORKFLOW", validation.errors.join("\n"));
      }
      report = await withBrowser(
        product,
        { phase: "dry_run", workDir: join(job.paths.logsDir, "browser"), log: job.log, headless: request.headless },
        async (session) => {
          const all = [...workflow.setup, ...workflow.steps];
          return runSteps(session.controller, all, { phase: "dry_run", log: job.log, retries: 1, screenshotDir: job.paths.screenshots });
        },
      );
      await writeJson(job.paths.executionLog, report);
      await writeJson(job.paths.browserLog, report.issues);
    } else {
      workflow = await rehearseWorkflow(job, product, { objective: request.objective as string, durationS: product.config.demo.default_duration, headless: request.headless }, request.providers ?? {});
    }
    await writeJson(job.paths.plan, workflow);
    job.metadata.workflow_version = WORKFLOW_VERSION;
    const validation = validateWorkflow(workflow, product.config);
    job.metadata.warnings.push(...validation.warnings);
    const ok = (report?.ok ?? true) && validation.errors.length === 0;
    if (!ok) {
      const failed = report?.steps.find((s) => s.status === "failed");
      if (failed) recordError(job, new DemoForgeError("WORKFLOW_FAILED", `Step ${failed.step_id}: ${failed.error}`), "dry_run", failed.step_id);
    }
    const metadata = await finishJob(job, ok ? (job.metadata.warnings.length ? "success_with_warnings" : "success") : "workflow_failure");
    return { metadata, workflow, report, validation };
  } catch (error) {
    recordError(job, error, "dry_run");
    return { metadata: await finishJob(job, statusForError(error)) };
  }
}
