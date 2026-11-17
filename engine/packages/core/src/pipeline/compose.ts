import { copyFile, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pickTemplate, type AudioClip, type CaptionCue, type VideoKind, type Workflow } from "@app-story/contracts";
import { buildCues, toSrt, toVtt } from "@app-story/captions";
import { resolveProductPath, type LoadedProduct } from "@app-story/products";
import { ensureDir, extractFrame, fileExists, toPosixRelative } from "@app-story/shared";
import { activeStretches, buildRenderProps, editTimes, getTemplate, placeNarration, planEdit, renderVideo, type TimelinePlan } from "@app-story/video";
import { saveRecord, type Job } from "../job-manager/job";
import type { RecordingOutcome } from "./record";

export interface ComposeResult {
  plan: TimelinePlan;
  cues: CaptionCue[];
}

async function copyAsset(job: Job, product: LoadedProduct, path: string | undefined, name: string): Promise<string | undefined> {
  if (!path) return undefined;
  const source = resolveProductPath(product, path);
  if (!(await fileExists(source))) {
    job.metadata.warnings.push(`Branding file not found: ${source}`);
    return undefined;
  }
  await ensureDir(job.paths.assetsDir);
  const target = join(job.paths.assetsDir, `${name}${extname(source)}`);
  await copyFile(source, target);
  return toPosixRelative(job.paths.root, target);
}

/** Captions + video render + thumbnail (captions and thumbnail are kept in the database). */
export async function composeVideo(
  job: Job,
  product: LoadedProduct,
  workflow: Workflow,
  clips: AudioClip[],
  recorded: RecordingOutcome,
  options: { kind?: VideoKind },
): Promise<ComposeResult> {
  const config = product.config;
  const templateName = pickTemplate(config.demo.template, options.kind);
  const template = getTemplate(templateName);
  job.log.info({ template: templateName, chosen: config.demo.template ? "product file" : `suits a ${options.kind ?? "general"} video` }, "video template");
  const toSrc = (path: string) => toPosixRelative(job.paths.root, path);

  // The editor's pass: idle stretches of the take are fast-forwarded; every time moves with them.
  const take = {
    durationMs: recorded.recording.durationMs,
    steps: recorded.report.steps,
    cursor: recorded.report.cursor,
    navigations: recorded.report.navigations,
    voice: recorded.placed,
  };
  const timeMap = planEdit(take.durationMs, activeStretches(take));
  const edited = editTimes(timeMap, take);
  if (edited.durationMs < take.durationMs - 500) {
    job.log.info({ fromS: (take.durationMs / 1000).toFixed(1), toS: (edited.durationMs / 1000).toFixed(1) }, "fast-forwarded idle stretches");
  }

  const { plan, placements } = placeNarration({
    template,
    recordingMs: edited.durationMs,
    intro: clips.find((c) => c.kind === "intro"),
    outro: clips.find((c) => c.kind === "outro"),
    segments: edited.voice,
    toSrc,
  });

  const cues = buildCues(
    placements.map((p) => ({ text: p.text, start_ms: p.startMs, duration_ms: p.durationMs, words: p.words })),
    { maxCharsPerLine: config.captions.max_chars_per_line, maxLines: 2 },
  );
  if (config.captions.enabled) {
    saveRecord(job, "captions_srt", toSrt(cues));
    saveRecord(job, "captions_vtt", toVtt(cues));
    await ensureDir(job.paths.videoDir);
    await writeFile(job.paths.finalCaptions, toSrt(cues), "utf8");
  }

  const props = buildRenderProps({
    config,
    template,
    plan,
    title: workflow.title,
    subtitle: workflow.summary,
    recordingSrc: toSrc(recorded.recording.path),
    recordingMs: edited.durationMs,
    timeMap,
    workflowSteps: workflow.steps,
    results: edited.steps,
    cursor: edited.cursor,
    startUrl: recorded.startUrl,
    navigations: edited.navigations,
    placements,
    cues,
    logoSrc: await copyAsset(job, product, config.branding.logo, "logo"),
    heroSrc: await heroStill(job, recorded),
    musicSrc: await copyAsset(job, product, config.branding.background_music, "music"),
  });

  // Thumbnail: the moment the outcome is verified.
  const verified = [...edited.steps].reverse().find((s) => s.status === "passed" && s.verified && s.action === "assert");
  const thumbAt = plan.recordingStartMs + (verified?.started_ms ?? edited.durationMs / 2) + 400;

  await renderVideo({
    publicDir: job.paths.root,
    props,
    outputFile: job.paths.finalVideo,
    thumbnailFile: job.paths.thumbnail,
    thumbnailAtMs: thumbAt,
    log: job.log,
  });
  const thumbnail = await readFile(job.paths.thumbnail).catch(() => undefined);
  if (thumbnail) saveRecord(job, "thumbnail", thumbnail);
  return { plan, cues };
}

/** A still of the app as the take opens, for the intro card. Optional: the intro works without it. */
async function heroStill(job: Job, recorded: RecordingOutcome): Promise<string | undefined> {
  const file = join(job.paths.assetsDir, "hero.png");
  await ensureDir(job.paths.assetsDir);
  const atSec = Math.min(1, Math.max(0, recorded.recording.durationMs / 1000 - 0.1));
  return extractFrame(recorded.recording.path, atSec, file).then(
    () => toPosixRelative(job.paths.root, file),
    (error: Error) => {
      job.log.warn({ error: error.message }, "could not take a still of the app for the intro");
      return undefined;
    },
  );
}
