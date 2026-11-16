import type { JobMetadata, JobStatus, Workflow } from "@demoforge/contracts";
import { WORKFLOW_VERSION } from "@demoforge/contracts";
import type { LoadedProduct } from "@demoforge/products";
import { validateWorkflow } from "@demoforge/workflow";
import { DemoForgeError, isDemoForgeError, probeMedia, slugify, writeJson } from "@demoforge/shared";
import { createJob, finishJob, recordError, saveMetadata, type Job } from "../job-manager/job";
import type { ProviderOverrides } from "../pipeline/providers";
import { rehearseWorkflow } from "../pipeline/rehearse";
import { prepareNarration } from "../pipeline/narrate";
import { recordWorkflow, type RecordingOutcome } from "../pipeline/record";
import { composeVideo } from "../pipeline/compose";
import { forgetPlan, loadSavedPlan, savePlan, savedPlanFile } from "../pipeline/plans";
import { statusForError } from "../pipeline/status";
import { runQualityChecks } from "../qa/quality";

export interface GenerateRequest {
  product: LoadedProduct;
  outputDir: string;
  /** What to demonstrate, in plain language. */
  objective: string;
  /** Short name for the job folder and the saved plan. Default: a slug of the objective. */
  name?: string;
  /** Replay this plan instead of planning (used by tests). */
  plan?: Workflow;
  /** Reuse and save verified plans in <output>/.plans/ (default: true). */
  reusePlans?: boolean;
  /** Ignore a saved plan and plan again. */
  fresh?: boolean;
  durationS?: number;
  templateName?: string;
  headless?: boolean;
  logLevel?: string;
  providers?: ProviderOverrides;
  onJobCreated?: (job: Job) => void;
}

/** Recording failures that mean "the steps no longer match the app", not "the app is down". */
const STALE_PLAN_CODES = new Set(["WORKFLOW_FAILED", "VERIFICATION_FAILED"]);

/**
 * The end-to-end pipeline:
 * plan (saved, or AI rehearsal) → narration → paced recording → captions → render →
 * quality checks → report. A video is only produced from a fully verified run.
 */
export async function generateDemo(request: GenerateRequest): Promise<JobMetadata> {
  const { product } = request;
  const name = request.name ?? slugify(request.objective);
  const job = await createJob({
    outputDir: request.outputDir,
    productId: product.id,
    name,
    mode: "guided",
    objective: request.objective,
    scenarioId: null,
    logLevel: request.logLevel,
  });
  request.onJobCreated?.(job);
  const overrides = request.providers ?? {};
  const config = product.config;
  const durationS = request.durationS ?? config.demo.default_duration;
  const reuse = request.reusePlans !== false && !request.plan;
  const planFile = savedPlanFile(request.outputDir, product.id, name);
  let phase = "plan";

  const planWithAI = () => rehearseWorkflow(job, product, { objective: request.objective, durationS, headless: request.headless }, overrides);

  const check = async (workflow: Workflow) => {
    job.metadata.workflow_version = WORKFLOW_VERSION;
    const validation = validateWorkflow(workflow, config);
    job.metadata.warnings.push(...validation.warnings);
    if (validation.errors.length > 0) {
      throw new DemoForgeError("UNSUPPORTED_WORKFLOW", `The plan is not safe or not verifiable:\n- ${validation.errors.join("\n- ")}`);
    }
    await writeJson(job.paths.plan, workflow);
    await saveMetadata(job);
  };

  // Narration first (script + speech), so the recording can be paced to it.
  const narrateAndRecord = async (workflow: Workflow) => {
    phase = "narration";
    const narration = await prepareNarration(job, product, workflow, { durationS }, overrides);
    await saveMetadata(job);
    phase = "recording";
    const recorded = await recordWorkflow(job, product, workflow, narration.clips, { headless: request.headless });
    job.metadata.recording = {
      path: recorded.recording.path,
      duration_s: round(recorded.recording.durationMs / 1000),
      width: recorded.recording.width,
      height: recorded.recording.height,
      engine: config.recording.engine,
    };
    failIfIncomplete(recorded);
    await saveMetadata(job);
    return { ...narration, recorded };
  };

  try {
    // 1. Plan: given, saved from an earlier video, or worked out by the AI in the real app.
    let workflow = request.plan;
    let fromSavedPlan = false;
    if (!workflow && reuse && !request.fresh) {
      workflow = await loadSavedPlan(planFile, request.objective);
      if (workflow) {
        fromSavedPlan = true;
        job.metadata.mode = "scenario";
        job.log.info({ file: planFile }, "replaying the saved plan (no AI planning needed)");
      }
    }
    workflow ??= await planWithAI();
    await check(workflow);

    // 2–3. Narration and recording. A saved plan that no longer matches the app is
    // dropped and the demo is planned again, once, in the same job.
    let take: Awaited<ReturnType<typeof narrateAndRecord>>;
    try {
      take = await narrateAndRecord(workflow);
    } catch (error) {
      if (!fromSavedPlan || !(isDemoForgeError(error) && STALE_PLAN_CODES.has(error.code))) throw error;
      job.log.warn({ error: (error as Error).message }, "the saved plan no longer works (did the app change?); planning again");
      job.metadata.warnings.push("The saved plan no longer matched the app, so the demo was planned again.");
      await forgetPlan(planFile);
      fromSavedPlan = false;
      job.metadata.mode = "guided";
      phase = "plan";
      workflow = await planWithAI();
      await check(workflow);
      take = await narrateAndRecord(workflow);
    }
    const { clips, silent, recorded } = take;

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
      silentNarration: silent,
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
      // Keep the verified plan so the next video of this feature replays it.
      if (reuse && !fromSavedPlan) await savePlan(planFile, workflow);
    }
    return await finishJob(job, status);
  } catch (error) {
    recordError(job, error, phase);
    job.log.error({ phase, error: (error as Error).message }, "job failed");
    return finishJob(job, statusForError(error));
  }
}

function failIfIncomplete(recorded: RecordingOutcome): void {
  if (recorded.report.ok) return;
  const failed = recorded.report.steps.find((s) => s.status === "failed");
  throw new DemoForgeError(
    failed?.error_code === "APP_UNAVAILABLE" ? "APP_UNAVAILABLE" : failed?.error_code === "POLICY_VIOLATION" ? "POLICY_VIOLATION" : "WORKFLOW_FAILED",
    `Step ${failed?.step_id} failed during recording: ${failed?.error}. No video was produced.`,
    { hint: failed?.screenshot ? `See ${failed.screenshot} and logs/trace.zip (open with \`npx playwright show-trace\`).` : undefined },
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
