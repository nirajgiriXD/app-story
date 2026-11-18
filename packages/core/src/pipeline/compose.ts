import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { pickTemplate, type AudioClip, type CaptionCue, type VideoKind, type Workflow } from "@app-story/contracts";
import { buildCues, toSrt, toVtt } from "@app-story/captions";
import { resolveProductPath, type LoadedProduct } from "@app-story/products";
import { ensureDir, extractFrame, fileExists, toPosixRelative } from "@app-story/shared";
import {
  activeStretches,
  buildRenderProps,
  editTimes,
  getTemplate,
  placeNarration,
  planEdit,
  renderGif,
  renderVideo,
  reshapeProps,
  type RenderProps,
  type TimelinePlan,
} from "@app-story/video";
import { saveRecord, type ExtraFile, type Job } from "../job-manager/job";
import type { LanguageVoice } from "./narrate";
import type { RecordingOutcome } from "./record";

export interface ComposeResult {
  plan: TimelinePlan;
  cues: CaptionCue[];
  /** Each narration line over the recording, where it is in the finished video (global ms). */
  lines: { text: string; stepIds: string[]; startMs: number; durationMs: number }[];
  /** What was rendered (for the editable timeline). */
  props: RenderProps;
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
  options: {
    kind?: VideoKind;
    /** Another language's words for the cards; its clips are `clips` and `recorded.placed`. */
    language?: { title: string; subtitle?: string; labels: NonNullable<RenderProps["labels"]> };
    /** Where the video and its captions go. Default: the job's final video; only that one gets a thumbnail and its captions kept. */
    out?: { video: string; captions: string };
  },
): Promise<ComposeResult> {
  const main = !options.out;
  const out = options.out ?? { video: job.paths.finalVideo, captions: job.paths.finalCaptions };
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
    if (main) {
      saveRecord(job, "captions_srt", toSrt(cues));
      saveRecord(job, "captions_vtt", toVtt(cues));
    }
    await ensureDir(dirname(out.captions));
    await writeFile(out.captions, toSrt(cues), "utf8");
  }

  const props = buildRenderProps({
    config,
    template,
    plan,
    title: options.language?.title ?? workflow.title,
    subtitle: options.language ? options.language.subtitle : workflow.summary,
    labels: options.language?.labels,
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
    fontSrc: await copyAsset(job, product, config.branding.font_file, "font"),
    backgroundSrc: await copyAsset(job, product, config.branding.background_image, "background"),
    heroSrc: await heroStill(job, recorded),
    musicSrc: await copyAsset(job, product, config.branding.background_music, "music"),
  });

  // Thumbnail: the poster, which is also frame 0 (the title card once its words have settled:
  // the title, the badge and the app's first screen), the kind video sites show best.
  await renderVideo({
    publicDir: job.paths.root,
    props,
    outputFile: out.video,
    thumbnailFile: main ? job.paths.thumbnail : undefined,
    thumbnailAtMs: props.posterMs,
    log: job.log,
    cacheDir: renderCacheDir(job),
  });
  const thumbnail = main ? await readFile(job.paths.thumbnail).catch(() => undefined) : undefined;
  if (thumbnail) saveRecord(job, "thumbnail", thumbnail);
  const lines = edited.voice.map((v) => ({ text: v.text, stepIds: v.step_ids, startMs: plan.recordingStartMs + v.start_ms, durationMs: v.duration_ms }));
  return { plan, cues, lines, props };
}

/**
 * The extra formats the product file asks for (`formats:`), made from the finished cut: the
 * same video in 9:16 or 1:1, and a GIF of its app part. One that fails is a warning: the
 * main video stands on its own.
 */
export async function renderExtras(job: Job, product: LoadedProduct, composed: ComposeResult): Promise<ExtraFile[]> {
  const extras: ExtraFile[] = [];
  for (const format of product.config.demo.formats) {
    const suffix = format === "gif" ? ".gif" : `.${format}.mp4`;
    const file = join(job.paths.videoDir, `final${suffix}`);
    try {
      if (format === "gif") {
        await renderGif(job.paths.finalVideo, file, composed.props.recording);
      } else {
        const props = reshapeProps(composed.props, format);
        await job.runtime.heavy(() => renderVideo({ publicDir: job.paths.root, props, outputFile: file, log: job.log, cacheDir: renderCacheDir(job) }));
      }
      extras.push({ file, suffix });
      job.log.info({ format }, "extra format ready");
    } catch (error) {
      job.log.warn({ format, error: (error as Error).message }, "an extra format failed");
      job.metadata.warnings.push(`The ${format} version could not be made: ${(error as Error).message}`);
    }
  }
  return extras;
}

/**
 * The video in each of the product's other languages, over the same recording: each line in
 * that language starts where the first language's line did (the recording was paced to the
 * longest of them), with that language's captions and card words. One that fails is a warning.
 */
export async function renderLanguages(
  job: Job,
  product: LoadedProduct,
  workflow: Workflow,
  recorded: RecordingOutcome,
  voices: readonly LanguageVoice[],
  options: { kind?: VideoKind },
): Promise<ExtraFile[]> {
  const extras: ExtraFile[] = [];
  for (const voice of voices) {
    const byId = new Map(voice.clips.map((c) => [c.id, c]));
    const placed = recorded.placed.flatMap((p) => {
      const clip = byId.get(p.id);
      return clip ? [{ ...clip, start_ms: p.start_ms }] : [];
    });
    const out = { video: join(job.paths.videoDir, `final.${voice.language}.mp4`), captions: join(job.paths.videoDir, `final.${voice.language}.srt`) };
    const t = voice.translation;
    try {
      await job.runtime.heavy(() =>
        composeVideo(
          job,
          product,
          workflow,
          voice.clips,
          { ...recorded, placed },
          {
            kind: options.kind,
            language: { title: t.title, subtitle: t.summary ?? undefined, labels: { cta: t.cta, badge: t.badge } },
            out,
          },
        ),
      );
      extras.push({ file: out.video, suffix: `.${voice.language}.mp4` });
      if (product.config.captions.enabled) extras.push({ file: out.captions, suffix: `.${voice.language}.srt` });
      job.log.info({ language: voice.language }, "video in another language ready");
    } catch (error) {
      job.log.warn({ language: voice.language, error: (error as Error).message }, "a language version failed");
      job.metadata.warnings.push(`The ${voice.language} version could not be made: ${(error as Error).message}`);
    }
  }
  return extras;
}

/** Drawn video chunks, kept across jobs: a re-render (the AI review's, a redo's) only draws what changed. */
function renderCacheDir(job: Job): string {
  return join(job.store.dataDir, "render-cache");
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
