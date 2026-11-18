import { join } from "node:path";
import { CAMERA_MOVE_MS, PAGE_CHANGE_SETTLE_MS, type AudioClip, type ExecutionReport, type PlacedClip, type Step, type Workflow } from "@app-story/contracts";
import type { RecorderResult } from "@app-story/browser";
import { NarrationPacer } from "@app-story/narration";
import type { LoadedProduct } from "@app-story/products";
import { actionLeadMs, runSteps } from "@app-story/workflow";
import { AppStoryError } from "@app-story/shared";
import { saveRecord, type Job } from "../job-manager/job";
import { withBrowser } from "./browser";
import { resetDemoData } from "./reset";

export interface RecordingOutcome {
  report: ExecutionReport;
  recording: RecorderResult;
  placed: PlacedClip[];
  startUrl: string;
}

/** The take opens wide: the app arrives (a fade of about 300 ms), then the camera has a full move to push in on the first step. */
const LEAD_IN_MS = CAMERA_MOVE_MS + 300;
/** Steps the video's camera frames (their element's area, or a check's outcome). */
const FRAMED_ACTIONS = new Set<Step["action"]>(["click", "fill", "select", "check", "uncheck", "hover", "assert"]);
const MAX_RECORDING_MS = 20 * 60 * 1000;

/**
 * The final take: replay the verified workflow in a fresh browser, at presentation
 * speed, paced to the narration, while recording. Setup steps run before recording;
 * cleanup steps run afterwards in their own session.
 */
export async function recordWorkflow(
  job: Job,
  product: LoadedProduct,
  workflow: Workflow,
  clips: AudioClip[],
  options: { headless?: boolean; holdMs?: ReadonlyMap<string, number> },
): Promise<RecordingOutcome> {
  const config = product.config;
  await resetDemoData(product, job.log, "the recording");
  const outcome = await withBrowser(
    product,
    {
      workDir: job.paths.recordingDir,
      log: job.log,
      record: true,
      headless: options.headless,
      traceFile: config.recording.trace ? job.paths.trace : undefined,
      loginState: job.loginState,
    },
    async (session) => {
      job.loginState = session.loginState;
      const controller = session.controller;
      if (workflow.setup.length > 0) {
        const setup = await runSteps(controller, workflow.setup, { phase: "recording", log: job.log, retries: 1 });
        if (!setup.ok) {
          const failed = setup.steps.find((s) => s.status === "failed");
          throw new AppStoryError("WORKFLOW_FAILED", `Setup step ${failed?.step_id} failed: ${failed?.error}`);
        }
      }

      const startUrl = controller.currentUrl();
      await session.startRecording();
      controller.setPresentationMode(true);
      await controller.wait(LEAD_IN_MS);

      const pacer = new NarrationPacer(
        clips.filter((c) => c.kind === "segment"),
        {
          now: () => controller.now(),
          wait: (ms) => controller.wait(ms),
        },
        {
          leadMs: (step) => actionLeadMs(step, { cursorMoveMs: config.recording.cursor_move_ms }),
          holdMs: options.holdMs,
          // After a page change, give the camera room to pull back, show the new page and push in.
          // The first entry is the page the take opens on, not a change.
          readyAt: (step) => {
            const navigations = controller.navigations ?? [];
            const change = navigations.length > 1 ? navigations.at(-1)?.t : undefined;
            return change !== undefined && FRAMED_ACTIONS.has(step.action) ? change + PAGE_CHANGE_SETTLE_MS : 0;
          },
        },
      );

      const report = await runSteps(controller, workflow.steps, {
        phase: "recording",
        log: job.log,
        retries: 1,
        minStepMs: config.recording.min_step_ms,
        screenshotDir: job.paths.screenshots,
        hooks: { beforeStep: (step) => pacer.beforeStep(step) },
        deadline: Date.now() + MAX_RECORDING_MS,
      });
      if (report.ok) await pacer.finish();
      const recording = await session.stopRecording(job.paths.rawRecording);
      return {
        report: {
          ...report,
          cursor: [...controller.cursor],
          issues: [...controller.issues],
          navigations: [...controller.navigations],
          scrolls: [...(controller.scrolls ?? [])],
        },
        recording,
        placed: pacer.placed,
        startUrl,
      };
    },
  );

  saveRecord(job, "execution", outcome.report);
  saveRecord(job, "browser_issues", outcome.report.issues);

  if (workflow.cleanup.length > 0) {
    await withBrowser(
      product,
      { workDir: join(job.paths.logsDir, "cleanup"), log: job.log, headless: options.headless, loginState: job.loginState },
      async (s) => {
        const cleanup = await runSteps(s.controller, workflow.cleanup, { phase: "recording", log: job.log, retries: 1 });
        if (!cleanup.ok) job.metadata.warnings.push("A cleanup step failed; demo data may need manual cleanup.");
      },
    );
  }
  return outcome;
}
