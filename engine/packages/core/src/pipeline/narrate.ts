import type { AudioClip, NarrationScript, Workflow } from "@demoforge/contracts";
import { synthesizeNarration, writeNarrationScript } from "@demoforge/narration";
import type { LoadedProduct } from "@demoforge/products";
import { writeJson, writeText } from "@demoforge/shared";
import type { Job } from "../job-manager/job";
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
  options: { durationS: number; audience?: string },
  overrides: ProviderOverrides,
): Promise<NarrationResult> {
  const config = product.config;
  const request = {
    workflow,
    product: productContext(product),
    language: config.demo.default_language,
    targetDurationS: options.durationS,
    audience: options.audience ?? config.demo.audience,
  };
  const { script, source } = workflow.steps.every((s) => s.narration)
    ? await writeNarrationScript({ ...request, provider: undefined })
    : await withProviderFallback(job, "narration", config, overrides, (provider) => writeNarrationScript({ ...request, provider }));
  job.log.info({ source, segments: script.segments.length }, "narration script ready");

  await writeJson(`${job.paths.narrationDir}/script.json`, script);
  await writeText(job.paths.script, scriptMarkdown(workflow, script));

  const tts = makeTTS(config.providers.tts, overrides);
  job.metadata.tts = { provider: tts.name, voice: tts.voice, model: tts.model };
  const clips = await synthesizeNarration(script, tts, job.paths.narrationDir, job.log);
  await writeJson(`${job.paths.narrationDir}/clips.json`, clips);
  if (tts.silent) {
    if (!config.captions.enabled) {
      job.metadata.warnings.push("Captions are disabled too, so the video has no narration at all.");
    }
  }
  return { script, clips, silent: Boolean(tts.silent) };
}

function scriptMarkdown(workflow: Workflow, script: NarrationScript): string {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const lines = [`# ${workflow.title}`, "", `**Intro:** ${script.intro}`, ""];
  for (const segment of script.segments) {
    const steps = segment.step_ids.map((id) => `${id} (${byId.get(id)?.description ?? "?"})`).join(", ");
    lines.push(`- _${steps}_`, `  ${segment.text}`, "");
  }
  lines.push(`**Outro:** ${script.outro}`, "");
  return lines.join("\n");
}
