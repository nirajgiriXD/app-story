import { join } from "node:path";
import type { AudioClip, ExecutionReport, PlacedClip, Workflow } from "@app-story/contracts";
import type { RecorderResult } from "@app-story/browser";
import { NarrationPacer } from "@app-story/narration";
import type { LoadedProduct } from "@app-story/products";
import { actionLeadMs, runSteps } from "@app-story/workflow";
import { AppStoryError } from "@app-story/shared";
import { saveRecord, type Job } from "../job-manager/job";
import { withBrowser } from "./browser";

export interface RecordingOutcome {
  report: ExecutionReport;
  recording: RecorderResult;
  placed: PlacedClip[];
  startUrl: string;
}

const LEAD_IN_MS = 900;
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
  options: { headless?: boolean },
): Promise<RecordingOutcome> {
  const config = product.config;
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
        { leadMs: (step) => actionLeadMs(step, { cursorMoveMs: config.recording.cursor_move_ms }) },
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
        report: { ...report, cursor: [...controller.cursor], issues: [...controller.issues], navigations: [...controller.navigations] },
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
