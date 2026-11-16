import { NarrationScriptSchema, type AudioClip, type NarrationScript, type VideoKind, type Workflow } from "@app-story/contracts";
import { PROMPT_VERSIONS } from "@app-story/ai";
import { estimateStepMs } from "@app-story/workflow";
import { synthesizeNarration, writeNarrationScript, type SpeechCache, type TTSProvider } from "@app-story/narration";
import type { LoadedProduct } from "@app-story/products";
import { saveRecord, type Job } from "../job-manager/job";
import { cacheKey } from "../store/store";
import { exclusive } from "./exclusive";
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
  options: { durationS: number; audience?: string; kind?: VideoKind; fresh?: boolean },
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

  // A replayed plan gets the same script as last time: no AI call, and the speech cache hits too.
  const { source: _source, ...plan } = workflow;
  const scriptKey = cacheKey("narration_script", { ...request, workflow: plan, prompt: PROMPT_VERSIONS.narration });
  const cached = options.fresh ? undefined : readCachedScript(job, scriptKey);
  let script: NarrationScript;
  let source: string;
  if (cached) {
    [script, source] = [cached, "cache"];
  } else {
    ({ script, source } = workflow.steps.every((s) => s.narration)
      ? await writeNarrationScript({ ...request, provider: undefined })
      : await withProviderFallback(job, "narration", config, overrides, (provider) => writeNarrationScript({ ...request, provider })));
    if (source === "ai") job.store.setCached(scriptKey, "narration_script", JSON.stringify(script));
  }
  job.log.info({ source, segments: script.segments.length }, "narration script ready");

  saveRecord(job, "narration_script", script);

  const tts = makeTTS(config.providers.tts, overrides);
  job.metadata.tts = { provider: tts.name, voice: tts.voice, model: tts.model };
  const cache = tts.silent ? undefined : speechCache(job, tts, config.providers.tts);
  const clips = await exclusive(() => synthesizeNarration(script, tts, job.paths.narrationDir, job.log, cache));
  saveRecord(job, "narration_clips", clips.map(({ path: _path, ...clip }) => clip));
  if (tts.silent) {
    if (!config.captions.enabled) {
      job.metadata.warnings.push("Captions are disabled too, so the video has no narration at all.");
    }
  }
  return { script, clips, silent: Boolean(tts.silent) };
}

function readCachedScript(job: Job, key: string): NarrationScript | undefined {
  const text = job.store.getCachedText(key);
  if (!text) return undefined;
  const parsed = NarrationScriptSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : undefined;
}

/** Finished clips by voice and text, so the same line in the same voice is never spoken twice. */
function speechCache(job: Job, tts: TTSProvider, settings: LoadedProduct["config"]["providers"]["tts"]): SpeechCache {
  // Bump `format` when the stored clip format changes (now: normalised 48 kHz mono WAV).
  const voice = { format: 1, provider: tts.name, voice: tts.voice, model: tts.model, speed: settings.speed, style: settings.style, accent: settings.accent };
  return {
    get: (text) => job.store.getCachedBlob(cacheKey("speech", { ...voice, text })),
    set: (text, audio) => job.store.setCached(cacheKey("speech", { ...voice, text }), "speech", audio),
  };
}
