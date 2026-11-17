import type { JobMetadata, JobStatus, VideoKind, Workflow } from "@app-story/contracts";
import { WORKFLOW_VERSION } from "@app-story/contracts";
import type { LoadedProduct } from "@app-story/products";
import { validateWorkflow } from "@app-story/workflow";
import { AppStoryError, isAppStoryError, probeMedia, slugify } from "@app-story/shared";
import { prepareRenderer } from "@app-story/video";
import { createJob, deliverVideo, finishJob, recordError, saveMetadata, saveRecord, type Job } from "../job-manager/job";
import type { ProviderOverrides } from "../pipeline/providers";
import { rehearseWorkflow } from "../pipeline/rehearse";
import { prepareNarration } from "../pipeline/narrate";
import { recordWorkflow, type RecordingOutcome } from "../pipeline/record";
import { composeVideo } from "../pipeline/compose";
import { forgetPlan, loadSavedPlan, savePlan } from "../pipeline/plans";
import { keepTake, type Take } from "../pipeline/takes";
import { statusForError } from "../pipeline/status";
import { exclusive } from "../pipeline/exclusive";
import { runQualityChecks } from "../qa/quality";

export interface GenerateRequest {
  product: LoadedProduct;
  outputDir: string;
  /** What to demonstrate, in plain language. */
  objective: string;
  /** Short name for the video file and the saved plan. Default: a slug of the objective. */
  name?: string;
  /** Replay this plan instead of planning (used by tests). */
  plan?: Workflow;
  /** Reuse and save verified plans next to the product file (default: true). */
  reusePlans?: boolean;
  /** Ignore a saved plan and plan again. */
  fresh?: boolean;
  durationS?: number;
  /** What the video is for; picks its look unless the product file sets `template:`. */
  kind?: VideoKind;
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
 * The recording is kept as a take, so the video can be made again with `redo`.
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
  // Bundle the video compositions while the AI and the browser work (errors resurface at render).
  void prepareRenderer().catch(() => undefined);
  saveRecord(job, "config", productConfigForRecord(product));
  const overrides = request.providers ?? {};
  const config = product.config;
  const durationS = request.durationS ?? config.demo.default_duration;
  const reuse = request.reusePlans !== false && !request.plan;
  let phase = "plan";

  const planWithAI = () =>
    rehearseWorkflow(
      job,
      product,
      { objective: request.objective, audience: config.demo.audience, kind: request.kind, durationS, headless: request.headless },
      overrides,
    );

  const check = async (workflow: Workflow) => {
    job.metadata.workflow_version = WORKFLOW_VERSION;
    const validation = validateWorkflow(workflow, config);
    job.metadata.warnings.push(...validation.warnings);
    if (validation.errors.length > 0) {
      throw new AppStoryError("UNSUPPORTED_WORKFLOW", `The plan is not safe or not verifiable:\n- ${validation.errors.join("\n- ")}`);
    }
    saveRecord(job, "plan", workflow);
    await saveMetadata(job);
  };

  // Narration first (script + speech), so the recording can be paced to it.
  const narrateAndRecord = async (workflow: Workflow) => {
    phase = "narration";
    const narration = await prepareNarration(job, product, workflow, { durationS, kind: request.kind, fresh: request.fresh }, overrides);
    await saveMetadata(job);
    phase = "recording";
    const recorded = await exclusive(async () => {
      // Never record while the renderer is still bundling: the screen capture would drop frames.
      await prepareRenderer().catch(() => undefined);
      return recordWorkflow(job, product, workflow, narration.clips, { headless: request.headless });
    });
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
      workflow = await loadSavedPlan(job.store, product, name, request.objective);
      if (workflow) {
        fromSavedPlan = true;
        job.metadata.mode = "scenario";
        job.log.info({ plan: name }, "replaying the saved plan (no AI planning needed)");
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
      if (!fromSavedPlan || !(isAppStoryError(error) && STALE_PLAN_CODES.has(error.code))) throw error;
      job.log.warn({ error: (error as Error).message }, "the saved plan no longer works (did the app change?); planning again");
      job.metadata.warnings.push("The saved plan no longer matched the app, so the demo was planned again.");
      await forgetPlan(product, name);
      fromSavedPlan = false;
      job.metadata.mode = "guided";
      phase = "plan";
      workflow = await planWithAI();
      await check(workflow);
      take = await narrateAndRecord(workflow);
    }
    const { clips, silent, recorded } = take;
    const kept: Take = {
      job_id: job.id,
      product_id: product.id,
      name,
      objective: request.objective,
      kind: request.kind ?? null,
      workflow,
      clips,
      recorded,
      silent,
    };

    // 4–5. Captions, render and quality checks.
    phase = "render";
    const status = await renderTake(job, product, kept, { onPhase: (p) => (phase = p) });
    if (status !== "failed" && reuse && !fromSavedPlan) await savePlan(product, name, workflow);
    return await finishJob(job, status);
  } catch (error) {
    recordError(job, error, phase);
    job.log.error({ phase, error: (error as Error).message }, "job failed");
    return finishJob(job, statusForError(error));
  }
}

/**
 * From a recording to a delivered video: captions, render, quality checks, then the video
 * goes to `output/` and the take is kept for `redo`. Used by new videos and by redos.
 */
export async function renderTake(job: Job, product: LoadedProduct, take: Take, options: { onPhase?: (phase: string) => void } = {}): Promise<JobStatus> {
  const { workflow, clips, recorded, silent } = take;
  const config = product.config;
  const kind = take.kind ?? undefined;
  // Kept before rendering, so a video whose render failed can be made again with `redo`.
  await keepTake(job, take).catch((error: Error) => job.log.warn({ error: error.message }, "could not keep the recording for redo"));

  options.onPhase?.("render");
  const composed = await exclusive(() => composeVideo(job, product, workflow, clips, recorded, { kind }));
  const final = await probeMedia(job.paths.finalVideo);
  job.metadata.video = { path: job.paths.finalVideo, thumbnail: null, duration_s: round(final.durationSec) };

  options.onPhase?.("quality");
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
  saveRecord(job, "quality", quality);
  const errors = quality.checks.filter((c) => !c.passed && c.severity === "error");
  const warnings = quality.checks.filter((c) => !c.passed && c.severity === "warning");
  job.metadata.quality = { passed: quality.passed, errors: errors.length, warnings: warnings.length };
  job.metadata.warnings.push(...warnings.map((w) => `quality: ${w.name}${w.detail ? ` (${w.detail})` : ""}`));

  if (errors.length > 0) {
    for (const e of errors)
      recordError(job, new AppStoryError("RENDER_FAILED", `Quality check failed: ${e.name}${e.detail ? ` (${e.detail})` : ""}`), "quality");
    return "failed";
  }
  // Only the video (and its captions) go to output/.
  await deliverVideo(job);
  return job.metadata.warnings.length > 0 ? "success_with_warnings" : "success";
}

function failIfIncomplete(recorded: RecordingOutcome): void {
  if (recorded.report.ok) return;
  const failed = recorded.report.steps.find((s) => s.status === "failed");
  throw new AppStoryError(
    failed?.error_code === "APP_UNAVAILABLE" ? "APP_UNAVAILABLE" : failed?.error_code === "POLICY_VIOLATION" ? "POLICY_VIOLATION" : "WORKFLOW_FAILED",
    `Step ${failed?.step_id} failed during recording: ${failed?.error}. No video was produced.`,
    { hint: failed?.screenshot ? `See ${failed.screenshot} and logs/trace.zip (open with \`npx playwright show-trace\`).` : undefined },
  );
}

/** The product settings used, kept with the job. A password written in the product file is hidden. */
function productConfigForRecord(product: LoadedProduct): unknown {
  const config = structuredClone(product.config);
  if (config.authentication.strategy === "auto" && !config.authentication.password.startsWith("env:")) {
    config.authentication.password = "***";
  }
  return { file: product.file, config };
}

const round = (n: number) => Math.round(n * 100) / 100;
