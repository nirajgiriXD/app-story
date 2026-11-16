import type { AudioClip, NarrationScript, VideoKind, Workflow } from "@showrun/contracts";
import { estimateStepMs } from "@showrun/workflow";
import { synthesizeNarration, writeNarrationScript } from "@showrun/narration";
import type { LoadedProduct } from "@showrun/products";
import { saveRecord, type Job } from "../job-manager/job";
import { makeTTS, withProviderFallback, type ProviderOverrides } from "./providers";
import { productContext } from "./rehearse";

export interface NarrationResult {
  script: NarrationScript;
  clips: AudioClip[];
  /** True when the narration track is silence (captions-only video). */
  silent: boolean;
}

export async function prepareNarration(
  job: Job,
  product: LoadedProduct,
  workflow: Workflow,
  options: { durationS: number; audience?: string; kind?: VideoKind },
  overrides: ProviderOverrides,
): Promise<NarrationResult> {
  const config = product.config;
  const pacing = {
    minStepMs: config.recording.min_step_ms,
    typingDelayMs: config.recording.typing_delay_ms,
    cursorMoveMs: config.recording.cursor_move_ms,
  };
  const request = {
    workflow,
    product: productContext(product),
    language: config.demo.default_language,
    targetDurationS: options.durationS,
    audience: options.audience ?? config.demo.audience,
    kind: options.kind,
    stepTimesMs: Object.fromEntries(workflow.steps.map((s) => [s.id, estimateStepMs(s, pacing)])),
  };
  const { script, source } = workflow.steps.every((s) => s.narration)
    ? await writeNarrationScript({ ...request, provider: undefined })
    : await withProviderFallback(job, "narration", config, overrides, (provider) => writeNarrationScript({ ...request, provider }));
  job.log.info({ source, segments: script.segments.length }, "narration script ready");

  saveRecord(job, "narration_script", script);

  const tts = makeTTS(config.providers.tts, overrides);
  job.metadata.tts = { provider: tts.name, voice: tts.voice, model: tts.model };
  const clips = await synthesizeNarration(script, tts, job.paths.narrationDir, job.log);
  saveRecord(job, "narration_clips", clips.map(({ path: _path, ...clip }) => clip));
  if (tts.silent) {
    if (!config.captions.enabled) {
      job.metadata.warnings.push("Captions are disabled too, so the video has no narration at all.");
    }
  }
  return { script, clips, silent: Boolean(tts.silent) };
}
