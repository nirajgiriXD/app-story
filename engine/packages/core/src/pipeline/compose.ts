import { copyFile, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AudioClip, CaptionCue, Workflow } from "@demoforge/contracts";
import { buildCues, toSrt, toVtt } from "@demoforge/captions";
import { resolveProductPath, type LoadedProduct } from "@demoforge/products";
import { ensureDir, fileExists, toPosixRelative } from "@demoforge/shared";
import { buildRenderProps, getTemplate, placeNarration, renderVideo, type TimelinePlan } from "@demoforge/video";
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

/** Captions + Remotion render + thumbnail (captions and thumbnail are kept in the database). */
export async function composeVideo(
  job: Job,
  product: LoadedProduct,
  workflow: Workflow,
  clips: AudioClip[],
  recorded: RecordingOutcome,
  options: { templateName?: string },
): Promise<ComposeResult> {
  const config = product.config;
  const template = getTemplate(options.templateName ?? config.demo.template);
  const toSrc = (path: string) => toPosixRelative(job.paths.root, path);

  const { plan, placements } = placeNarration({
    template,
    recordingMs: recorded.recording.durationMs,
    intro: clips.find((c) => c.kind === "intro"),
    outro: clips.find((c) => c.kind === "outro"),
    segments: recorded.placed,
    toSrc,
  });

  const cues = buildCues(
    placements.map((p) => ({ text: p.text, start_ms: p.startMs, duration_ms: p.durationMs })),
    { maxCharsPerLine: config.captions.max_chars_per_line, maxLines: 2 },
  );
  if (config.captions.enabled) {
    saveRecord(job, "captions_srt", toSrt(cues));
    saveRecord(job, "captions_vtt", toVtt(cues));
  }

  const props = buildRenderProps({
    config,
    template,
    plan,
    title: workflow.title,
    subtitle: workflow.summary,
    recordingSrc: toSrc(recorded.recording.path),
    recordingMs: recorded.recording.durationMs,
    workflowSteps: workflow.steps,
    results: recorded.report.steps,
    cursor: recorded.report.cursor,
    startUrl: recorded.startUrl,
    placements,
    cues,
    logoSrc: await copyAsset(job, product, config.branding.logo, "logo"),
    musicSrc: await copyAsset(job, product, config.branding.background_music, "music"),
  });

  // Thumbnail: the moment the outcome is verified.
  const verified = [...recorded.report.steps].reverse().find((s) => s.status === "passed" && s.verified && s.action === "assert");
  const thumbAt = plan.recordingStartMs + (verified?.started_ms ?? recorded.recording.durationMs / 2) + 400;

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
