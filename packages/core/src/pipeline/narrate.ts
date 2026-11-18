import { join } from "node:path";
import {
  NarrationScriptSchema,
  NarrationTranslationSchema,
  pickTemplate,
  type AudioClip,
  type NarrationScript,
  type NarrationTranslation,
  type VideoKind,
  type Workflow,
} from "@app-story/contracts";
import { AppStoryError, toAppStoryError } from "@app-story/shared";
import { PHASE_EFFORT, PROMPT_VERSIONS, loadPrompt } from "@app-story/ai";
import { DEFAULT_CTA, getTemplate } from "@app-story/video";
import { estimateStepMs } from "@app-story/workflow";
import { synthesizeNarration, writeNarrationScript, type SpeechCache, type TTSProvider } from "@app-story/narration";
import type { LoadedProduct } from "@app-story/products";
import { saveRecord, type Job } from "../job-manager/job";
import { cacheKey } from "../store/store";
import { makeTTS, withProviderFallback, type ProviderOverrides } from "./providers";
import { productContext } from "./rehearse";

export interface NarrationResult {
  script: NarrationScript;
  /** Where the script came from: the plan file, the cache, the scenario's own lines, or the AI. */
  source: string;
  clips: AudioClip[];
  /** True when the narration track is silence (captions-only video). */
  silent: boolean;
}

export async function prepareNarration(
  job: Job,
  product: LoadedProduct,
  workflow: Workflow,
  options: { durationS: number; audience?: string; kind?: VideoKind; fresh?: boolean; replay?: boolean },
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
    tone: config.demo.tone,
    stepTimesMs: Object.fromEntries(workflow.steps.map((s) => [s.id, estimateStepMs(s, pacing)])),
  };

  // A replayed plan gets the same script as last time: the one saved in its file, or the
  // cached one. No AI call, and the speech cache hits too.
  const { source: _source, narration: _saved, ...plan } = workflow;
  const scriptKey = cacheKey("narration_script", { ...request, workflow: plan, prompt: PROMPT_VERSIONS.narration });
  const saved = options.fresh ? undefined : savedScript(workflow, config.demo.default_language);
  const cached = options.fresh || saved ? undefined : readCachedScript(job, scriptKey);
  let script: NarrationScript;
  let source: string;
  if (saved) {
    [script, source] = [saved, "plan"];
  } else if (cached) {
    [script, source] = [cached, "cache"];
  } else {
    if (options.replay) job.log.info("this plan has no saved narration yet: the AI writes it once, and it is saved in the plan");
    ({ script, source } = workflow.steps.every((s) => s.narration)
      ? await writeNarrationScript({ ...request, provider: undefined })
      : await withProviderFallback(job, "narration", config, overrides, (provider) => writeNarrationScript({ ...request, provider })).catch(
          (error: unknown) => {
            if (!options.replay) throw error;
            const e = toAppStoryError(error);
            throw new AppStoryError(e.code, `This plan has no saved narration, and the AI could not write it: ${e.message}`, {
              hint: "Make its video once where an AI key is set, then commit the plan file: it then holds the narration, and replays need no AI.",
              cause: error,
            });
          },
        ));
    if (source === "ai") job.store.setCached(scriptKey, "narration_script", JSON.stringify(script));
  }
  job.log.info({ source, segments: script.segments.length }, "narration script ready");

  saveRecord(job, "narration_script", script);

  const tts = makeTTS(config.providers.tts, overrides);
  job.metadata.tts = { provider: tts.name, voice: tts.voice, model: tts.model };
  const cache = tts.silent ? undefined : speechCache(job, tts, config.providers.tts);
  const clips = await job.runtime.heavy(() =>
    synthesizeNarration(script, tts, job.paths.narrationDir, job.log, cache, { language: config.demo.default_language }),
  );
  saveRecord(
    job,
    "narration_clips",
    clips.map(({ path: _path, ...clip }) => clip),
  );
  if (tts.silent) {
    if (!config.captions.enabled) {
      job.metadata.warnings.push("Captions are disabled too, so the video has no narration at all.");
    }
  }
  return { script, source, clips, silent: Boolean(tts.silent) };
}

/** The narration in one of the product's other languages, spoken. */
export interface LanguageVoice {
  language: string;
  translation: NarrationTranslation;
  clips: AudioClip[];
}

/**
 * The narration in each of the product file's other languages (`language: en, de`), voiced
 * line for line, so every language plays over the same recording. The translation comes
 * from the plan file when it was saved for this very narration, else from the cache, else
 * from the AI (it keeps the `{{@step}}` anchors).
 */
export async function prepareTranslations(
  job: Job,
  product: LoadedProduct,
  workflow: Workflow,
  base: NarrationResult,
  options: { kind?: VideoKind; fresh?: boolean; replay?: boolean },
  overrides: ProviderOverrides,
): Promise<LanguageVoice[]> {
  const config = product.config;
  if (config.demo.languages.length === 0) return [];
  const original = {
    language: config.demo.default_language,
    title: workflow.title,
    summary: workflow.summary ?? null,
    badge: getTemplate(pickTemplate(config.demo.template, options.kind)).title.badge ?? null,
    cta: config.branding.cta ?? DEFAULT_CTA,
    script: base.script,
  };
  const tts = makeTTS(config.providers.tts, overrides);
  const cache = tts.silent ? undefined : speechCache(job, tts, config.providers.tts);
  const voices: LanguageVoice[] = [];
  for (const language of config.demo.languages) {
    const saved = options.fresh ? undefined : savedTranslation(workflow, base.script, language);
    const key = cacheKey("narration_translation", { ...original, to: language, prompt: PROMPT_VERSIONS.translation });
    const cached = saved || options.fresh ? undefined : readCachedTranslation(job, key, base.script);
    let translation = saved ?? cached;
    if (!translation) {
      translation = await withProviderFallback(job, `translation (${language})`, config, overrides, async (provider) =>
        checkTranslation(
          await provider.generateStructuredOutput({
            system: loadPrompt("translation"),
            prompt: translationPrompt(original, language),
            schema: NarrationTranslationSchema,
            schemaName: "narration_translation",
            effort: PHASE_EFFORT.translation,
          }),
          base.script,
        ),
      ).catch((error: unknown) => {
        if (!options.replay) throw error;
        const e = toAppStoryError(error);
        throw new AppStoryError(e.code, `This plan has no saved ${language} narration, and the AI could not translate it: ${e.message}`, {
          hint: "Make its video once where an AI key is set, then commit the plan file: it then holds every language, and replays need no AI.",
          cause: error,
        });
      });
      job.store.setCached(key, "narration_translation", JSON.stringify(translation));
    }
    job.log.info({ language, source: saved ? "plan" : cached ? "cache" : "ai" }, "narration translated");
    const script: NarrationScript = {
      intro: translation.intro,
      segments: base.script.segments.map((s, i) => ({ step_ids: s.step_ids, text: translation.segments[i] as string })),
      outro: translation.outro,
    };
    const dir = join(job.paths.narrationDir, language);
    const clips = await job.runtime.heavy(() => synthesizeNarration(script, tts, dir, job.log, cache, { language }));
    voices.push({ language, translation, clips });
  }
  saveRecord(job, "narration_translations", Object.fromEntries(voices.map((v) => [v.language, v.translation])));
  return voices;
}

function translationPrompt(
  original: { language: string; title: string; summary: string | null; badge: string | null; cta: string; script: NarrationScript },
  to: string,
): string {
  return [
    `# Translate from ${original.language} to ${to}`,
    `Title: ${original.title}`,
    `Summary: ${original.summary ?? "(none)"}`,
    `Badge: ${original.badge ?? "(none)"}`,
    `Call to action: ${original.cta}`,
    `Intro: ${original.script.intro}`,
    "Segments:",
    ...original.script.segments.map((s, i) => `${i + 1}. ${s.text}`),
    `Outro: ${original.script.outro}`,
  ].join("\n");
}

/** A translation must have one line per original segment, and keep the `{host}` placeholder. */
export function checkTranslation(translation: NarrationTranslation, script: NarrationScript): NarrationTranslation {
  if (translation.segments.length !== script.segments.length) {
    throw new AppStoryError("PROVIDER_INVALID_OUTPUT", `The translation has ${translation.segments.length} lines for ${script.segments.length} segments.`);
  }
  return translation.cta.includes("{host}") ? translation : { ...translation, cta: `${translation.cta} {host}` };
}

/** The translation saved in the plan file, if it was made from this very narration. */
function savedTranslation(workflow: Workflow, script: NarrationScript, language: string): NarrationTranslation | undefined {
  const saved = workflow.narration;
  const translation = saved?.translations?.[language];
  if (!saved || !translation) return undefined;
  const same =
    saved.intro === script.intro &&
    saved.outro === script.outro &&
    saved.segments.length === script.segments.length &&
    saved.segments.every((s, i) => s.text === script.segments[i]?.text);
  return same && translation.segments.length === script.segments.length ? translation : undefined;
}

function readCachedTranslation(job: Job, key: string, script: NarrationScript): NarrationTranslation | undefined {
  const text = job.store.getCachedText(key);
  if (!text) return undefined;
  const parsed = NarrationTranslationSchema.safeParse(JSON.parse(text));
  return parsed.success && parsed.data.segments.length === script.segments.length ? parsed.data : undefined;
}

/** The narration saved in the plan file, if it is in this language and still covers exactly the plan's steps. */
export function savedScript(workflow: Workflow, language: string): NarrationScript | undefined {
  const saved = workflow.narration;
  if (!saved || saved.language !== language) return undefined;
  const covered = saved.segments.flatMap((s) => s.step_ids);
  const steps = workflow.steps.map((s) => s.id);
  if (covered.length !== steps.length || covered.some((id, i) => id !== steps[i])) return undefined;
  return { intro: saved.intro, segments: saved.segments, outro: saved.outro };
}

function readCachedScript(job: Job, key: string): NarrationScript | undefined {
  const text = job.store.getCachedText(key);
  if (!text) return undefined;
  const parsed = NarrationScriptSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : undefined;
}

/** Finished clips by voice and text, so the same line in the same voice is never spoken twice. */
export function speechCache(job: Job, tts: TTSProvider, settings: LoadedProduct["config"]["providers"]["tts"]): SpeechCache {
  // Bump `format` when the stored clip format changes (now: voice chain, normalised 48 kHz mono WAV).
  const voice = {
    format: 2,
    provider: tts.name,
    voice: tts.voice,
    model: tts.model,
    variant: tts.variant,
    speed: settings.speed,
    style: settings.style,
    // Calm was the only delivery before tones: leaving it out keeps clips spoken before.
    tone: settings.tone === "calm" ? undefined : settings.tone,
    accent: settings.accent,
  };
  return {
    get: (text) => job.store.getCachedBlob(cacheKey("speech", { ...voice, text })),
    set: (text, audio) => job.store.setCached(cacheKey("speech", { ...voice, text }), "speech", audio),
  };
}
