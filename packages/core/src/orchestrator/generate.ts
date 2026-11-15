import type { JobMetadata, JobStatus, Workflow } from "@demoforge/contracts";
import { WORKFLOW_VERSION } from "@demoforge/contracts";
import { loadScenario, saveScenario, type LoadedProduct } from "@demoforge/products";
import { validateWorkflow } from "@demoforge/workflow";
import { DemoForgeError, probeMedia, slugify, writeJson } from "@demoforge/shared";
import { createJob, finishJob, recordError, saveMetadata, type Job } from "../job-manager/job";
import type { ProviderOverrides } from "../pipeline/providers";
import { rehearseWorkflow } from "../pipeline/rehearse";
import { prepareNarration } from "../pipeline/narrate";
import { recordWorkflow } from "../pipeline/record";
import { composeVideo } from "../pipeline/compose";
import { statusForError } from "../pipeline/status";
import { runQualityChecks } from "../qa/quality";

export interface GenerateRequest {
  product: LoadedProduct;
  outputDir: string;
  /** Mode A: natural-language objective. */
  objective?: string;
  /** Mode B: saved scenario id. */
  scenarioId?: string;
  allowUnapproved?: boolean;
  /** Save the AI-planned workflow as an (unapproved) scenario in the product folder. */
  saveScenario?: boolean;
  audience?: string;
  durationS?: number;
  templateName?: string;
  headless?: boolean;
  logLevel?: string;
  providers?: ProviderOverrides;
  onJobCreated?: (job: Job) => void;
}

/**
 * The end-to-end pipeline:
 * workflow (scenario or AI rehearsal) → narration → paced recording → captions →
 * render → quality checks → report. A video is only produced from a fully verified run.
 */
export async function generateDemo(request: GenerateRequest): Promise<JobMetadata> {
  const { product } = request;
  if (!request.objective === !request.scenarioId) {
    throw new DemoForgeError("CONFIG_INVALID", "Provide either an objective or a scenario, not both.");
  }
  const job = await createJob({
    outputDir: request.outputDir,
    productId: product.id,
    name: request.scenarioId ?? slugify(request.objective as string),
    mode: request.scenarioId ? "scenario" : "guided",
    objective: request.objective ?? null,
    scenarioId: request.scenarioId ?? null,
    logLevel: request.logLevel,
  });
  request.onJobCreated?.(job);
  const overrides = request.providers ?? {};
  const config = product.config;
  const durationS = request.durationS ?? config.demo.default_duration;
  let phase = "workflow";

  try {
    // 1. Workflow
    const workflow = request.scenarioId
      ? await loadApprovedScenario(job, product, request.scenarioId, request.allowUnapproved ?? false)
      : await rehearseWorkflow(job, product, { objective: request.objective as string, audience: request.audience, durationS, headless: request.headless }, overrides);
    job.metadata.workflow_version = WORKFLOW_VERSION;
    const validation = validateWorkflow(workflow, config);
    job.metadata.warnings.push(...validation.warnings);
    if (validation.errors.length > 0) {
      throw new DemoForgeError("UNSUPPORTED_WORKFLOW", `The workflow is not safe or not verifiable:\n- ${validation.errors.join("\n- ")}`);
    }
    if (!request.scenarioId) {
      if (request.saveScenario) {
        const file = await saveScenario(product, { ...workflow, id: uniqueId(product, workflow.id) });
        job.log.info({ file }, "saved scenario draft (unapproved) to the product folder");
      }
    } else {
      await writeJson(job.paths.plan, workflow);
    }
    await saveMetadata(job);

    // 2. Narration (script + speech), before recording so the take can be paced to it
    phase = "narration";
    const { clips } = await prepareNarration(job, product, workflow, { durationS, audience: request.audience }, overrides);
    await saveMetadata(job);

    // 3. Recording
    phase = "recording";
    const recorded = await recordWorkflow(job, product, workflow, clips, { headless: request.headless });
    job.metadata.recording = {
      path: recorded.recording.path,
      duration_s: round(recorded.recording.durationMs / 1000),
      width: recorded.recording.width,
      height: recorded.recording.height,
      engine: config.recording.engine,
    };
    if (!recorded.report.ok) {
      const failed = recorded.report.steps.find((s) => s.status === "failed");
      throw new DemoForgeError(
        failed?.error_code === "APP_UNAVAILABLE" ? "APP_UNAVAILABLE" : failed?.error_code === "POLICY_VIOLATION" ? "POLICY_VIOLATION" : "WORKFLOW_FAILED",
        `Step ${failed?.step_id} failed during recording: ${failed?.error}. No video was produced.`,
        { hint: failed?.screenshot ? `See ${failed.screenshot} and logs/trace.zip (open with \`npx playwright show-trace\`).` : undefined },
      );
    }
    await saveMetadata(job);

    // 4. Captions + render
    phase = "render";
    const composed = await composeVideo(job, product, workflow, clips, recorded, { templateName: request.templateName });
    const final = await probeMedia(job.paths.finalVideo);
    job.metadata.video = { path: job.paths.finalVideo, thumbnail: job.paths.thumbnail, duration_s: round(final.durationSec) };

    // 5. Quality
    phase = "quality";
    const quality = await runQualityChecks({
      jobId: job.id,
      paths: job.paths,
      config,
      workflow,
      recorded,
      clips,
      cues: composed.cues,
      plan: composed.plan,
    });
    await writeJson(job.paths.quality, quality);
    const errors = quality.checks.filter((c) => !c.passed && c.severity === "error");
    const warnings = quality.checks.filter((c) => !c.passed && c.severity === "warning");
    job.metadata.quality = { passed: quality.passed, errors: errors.length, warnings: warnings.length };
    job.metadata.warnings.push(...warnings.map((w) => `quality: ${w.name}${w.detail ? ` (${w.detail})` : ""}`));

    let status: JobStatus;
    if (errors.length > 0) {
      for (const e of errors) recordError(job, new DemoForgeError("RENDER_FAILED", `Quality check failed: ${e.name}${e.detail ? ` (${e.detail})` : ""}`), "quality");
      status = "failed";
    } else {
      status = job.metadata.warnings.length > 0 ? "success_with_warnings" : "success";
    }
    return await finishJob(job, status, request.outputDir);
  } catch (error) {
    recordError(job, error, phase);
    job.log.error({ phase, error: (error as Error).message }, "job failed");
    return finishJob(job, statusForError(error), request.outputDir);
  }
}

async function loadApprovedScenario(job: Job, product: LoadedProduct, id: string, allowUnapproved: boolean): Promise<Workflow> {
  const workflow = await loadScenario(product, id);
  if (!workflow.approved) {
    if (!allowUnapproved) {
      throw new DemoForgeError("SCENARIO_NOT_APPROVED", `Scenario '${id}' has not been approved.`, {
        hint: "Review the steps, then set `approved: true` in the scenario file (or pass --allow-unapproved for a test run).",
      });
    }
    job.metadata.warnings.push(`Scenario '${id}' is not approved; this video is for review only.`);
  }
  return workflow;
}

function uniqueId(product: LoadedProduct, id: string): string {
  if (!product.scenarios.includes(id)) return id;
  let n = 2;
  while (product.scenarios.includes(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}

const round = (n: number) => Math.round(n * 100) / 100;
