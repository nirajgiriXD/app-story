import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobMetadata, JobStatus, NarrationScript, VideoKind, Workflow } from "@app-story/contracts";

import { WORKFLOW_VERSION } from "@app-story/contracts";
import type { LoadedProduct } from "@app-story/products";
import { validateWorkflow } from "@app-story/workflow";
import { AppStoryError, isAppStoryError, probeMedia, slugify } from "@app-story/shared";
import { prepareRenderer, toOtio } from "@app-story/video";
import { createJob, deliverVideo, finishJob, recordError, saveMetadata, saveRecord, type Job } from "../job-manager/job";
import { withProviderFallback, type ProviderOverrides } from "../pipeline/providers";
import type { Runtime } from "../runtime";
import { rehearseWorkflow } from "../pipeline/rehearse";
import { prepareNarration } from "../pipeline/narrate";
import { recordWorkflow, type RecordingOutcome } from "../pipeline/record";
import { composeVideo, type ComposeResult } from "../pipeline/compose";
import { forgetPlan, loadSavedPlan, savePlan } from "../pipeline/plans";
import { keepTake, type KeptTake, type Take } from "../pipeline/takes";
import { statusForError } from "../pipeline/status";
import { runQualityChecks } from "../qa/quality";
import { grabFrames, linesToReview, REVIEW_REQUEST, reviewPrompt, stepsToShowWide, visualReviewEnabled } from "../qa/visual-review";

export interface GenerateRequest {
  product: LoadedProduct;
  outputDir: string;
  /** What to demonstrate, in plain language. */
  objective: string;
  /** Short name for the video file and the saved plan. Default: a slug of the objective. */
  name?: string;
  /** Replay this plan instead of planning (used by tests, `resumeDemo` and `replayPlans`). */
  plan?: Workflow;
  /**
   * `plan` is a saved plan, replayed as it is: it is never planned again, even if it fails.
   * What this video adds to it (narration written for it, framing fixes) is saved back to its file.
   */
  replay?: boolean;
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
  /** The failed video whose plan `plan` is (see `resumeDemo`): saved for reuse once this video passes. */
  resumedFrom?: string;
  /** Default: the process's runtime. */
  runtime?: Runtime;
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
    runtime: request.runtime,
  });
  job.metadata.kind = request.kind ?? null;
  job.metadata.resumed_from = request.resumedFrom ?? null;
  if (request.replay) job.metadata.mode = "scenario";
  request.onJobCreated?.(job);
  // Bundle the video compositions while the AI and the browser work (errors resurface at render).
  void prepareRenderer().catch(() => undefined);
  saveRecord(job, "config", productConfigForRecord(product));
  const overrides = request.providers ?? {};
  const config = product.config;
  const durationS = request.durationS ?? config.demo.default_duration;
  const reuse = request.reusePlans !== false && !request.plan;
  // A resumed plan was made by the AI like any other: it is kept once its video passes. A
  // replayed one is written back only if this video added to it (see `planToSave`).
  const keepPlan = request.reusePlans !== false && (!request.plan || Boolean(request.resumedFrom) || Boolean(request.replay));
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
    const narration = await prepareNarration(
      job,
      product,
      workflow,
      { durationS, kind: request.kind, fresh: request.fresh, replay: request.replay },
      overrides,
    );
    await saveMetadata(job);
    phase = "recording";
    const recorded = await job.runtime.heavy(async () => {
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
    const { clips, silent, recorded, script, source } = take;
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

    // 4–5. Captions, render and quality checks. A replayed plan whose narration was already
    // saved was reviewed when it was made: it needs no AI at all.
    phase = "render";
    const review = request.replay && source !== "ai" ? undefined : { overrides };
    const rendered = await renderTake(job, product, kept, { onPhase: (p) => (phase = p), review });
    if (rendered.status !== "failed" && keepPlan) {
      const plan = planToSave(rendered.workflow, { kind: request.kind, language: config.demo.default_language, script });
      await savePlan(product, name, plan);
    }
    return await finishJob(job, rendered.status);
  } catch (error) {
    recordError(job, error, phase);
    job.log.error({ phase, error: (error as Error).message }, "job failed");
    return finishJob(job, statusForError(error));
  }
}

/**
 * The plan as it is saved after a video: with the framing the AI review settled on, the kind
 * of video it was made for (its look on replay) and its narration, so the next video of it
 * needs no AI.
 */
export function planToSave(workflow: Workflow, made: { kind?: VideoKind; language: string; script: NarrationScript }): Workflow {
  return { ...workflow, kind: made.kind ?? workflow.kind, narration: { language: made.language, ...made.script } };
}

/**
 * From a recording to a delivered video: captions, render, quality checks, then the video
 * goes to `output/` and the take is kept for `redo`. Used by new videos and by redos.
 * Returns the plan as it was rendered: the AI review may have re-framed some of its steps.
 */
export async function renderTake(
  job: Job,
  product: LoadedProduct,
  take: Take,
  options: { onPhase?: (phase: string) => void; review?: { overrides: ProviderOverrides } } = {},
): Promise<{ status: JobStatus; workflow: Workflow }> {
  const { workflow, clips, recorded, silent } = take;
  const config = product.config;
  const kind = take.kind ?? undefined;
  // Kept before rendering, so a video whose render failed can be made again with `redo`.
  const kept = await keepTake(job, take).catch((error: Error) => {
    job.log.warn({ error: error.message }, "could not keep the recording for redo");
    return undefined;
  });

  options.onPhase?.("render");
  let composed = await job.runtime.heavy(() => composeVideo(job, product, workflow, clips, recorded, { kind }));
  let rendered = workflow;
  if (options.review && visualReviewEnabled()) {
    options.onPhase?.("review");
    const fixed = await reviewAndFix(job, product, take, composed, options.review.overrides);
    if (fixed) [composed, rendered] = [fixed.composed, fixed.workflow];
  }
  if (kept) await writeTimeline(job, kept, composed);
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
    return { status: "failed", workflow: rendered };
  }
  // Only the video (and its captions) go to output/.
  await deliverVideo(job);
  return { status: job.metadata.warnings.length > 0 ? "success_with_warnings" : "success", workflow: rendered };
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

/**
 * An editor's look at the cut: the AI sees a frame for each narration line and says whether
 * what the line is about is on screen. Steps whose shot failed are shown wide and the video
 * is rendered once more (no browser). Any problem with the review keeps the first cut.
 */
async function reviewAndFix(
  job: Job,
  product: LoadedProduct,
  take: Take,
  composed: ComposeResult,
  overrides: ProviderOverrides,
): Promise<{ composed: ComposeResult; workflow: Workflow } | undefined> {
  try {
    const lines = linesToReview(composed.lines);
    if (lines.length === 0) return undefined;
    const images = await grabFrames(job, lines);
    const review = await withProviderFallback(job, "review", product.config, overrides, (provider) =>
      provider.generateStructuredOutput({
        system: REVIEW_REQUEST.system(),
        prompt: reviewPrompt(take.workflow, lines),
        schema: REVIEW_REQUEST.schema,
        schemaName: REVIEW_REQUEST.schemaName,
        effort: REVIEW_REQUEST.effort,
        images,
      }),
    );
    saveRecord(job, "visual_review", review);
    const { stepIds, issues } = stepsToShowWide(review, lines);
    if (stepIds.length === 0) {
      job.log.info({ frames: lines.length }, "AI review: every shot shows what the narration is about");
      return undefined;
    }
    job.log.info({ issues }, "AI review: some shots miss their subject; showing those steps wide");
    job.metadata.warnings.push(`AI review re-framed ${stepIds.length} step(s): ${issues.join("; ")}`);
    const wide = new Set(stepIds);
    const workflow = { ...take.workflow, steps: take.workflow.steps.map((s) => (wide.has(s.id) ? { ...s, zoom: false } : s)) };
    const recomposed = await job.runtime.heavy(() => composeVideo(job, product, workflow, take.clips, take.recorded, { kind: take.kind ?? undefined }));
    return { composed: recomposed, workflow };
  } catch (error) {
    job.log.warn({ error: (error as Error).message }, "AI review failed; the video is kept as it is");
    job.metadata.warnings.push(`AI review skipped: ${(error as Error).message}`);
    return undefined;
  }
}

/** The edit as an OpenTimelineIO file next to the take, pointing at the take's own files. */
async function writeTimeline(job: Job, kept: KeptTake, composed: ComposeResult): Promise<void> {
  const fileOf = (src: string) => kept.nameOf(join(job.paths.root, src)) ?? kept.nameOf(src) ?? src;
  const file = join(kept.dir, "timeline.otio");
  await writeFile(file, toOtio(composed.props, fileOf)).then(
    () => job.log.info({ file }, "editable timeline saved (opens in DaVinci Resolve and other OpenTimelineIO editors)"),
    (error: Error) => job.log.warn({ error: error.message }, "could not save the editable timeline"),
  );
}
