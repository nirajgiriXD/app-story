import { copyFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JobMetadata, TemplateName } from "@app-story/contracts";
import type { LoadedProduct } from "@app-story/products";
import { AppStoryError, ensureDir } from "@app-story/shared";
import { prepareRenderer } from "@app-story/video";
import { createJob, finishJob, recordError, saveMetadata, saveRecord } from "../job-manager/job";
import { statusForError } from "../pipeline/status";
import { listTakes, loadTake, type Take } from "../pipeline/takes";
import { storeFor, type Runtime } from "../runtime";
import { renderTake } from "./generate";

export interface RedoRequest {
  product: LoadedProduct;
  outputDir: string;
  /** The video to make again: its job id. Default: the product's newest video that kept its recording. */
  jobId?: string;
  /** Use this look instead of the product file's `template:` (or the one picked for the video). */
  template?: TemplateName;
  logLevel?: string;
  onJobCreated?: (job: { id: string; paths: { root: string } }) => void;
  /** Default: the process's runtime. */
  runtime?: Runtime;
}

/**
 * Make a video again from its kept recording: no browser, no app, no AI. The product
 * file is read again, so a new look, logo, colour, music or captions setting applies;
 * the clicks, the voice and the timing stay as they were.
 */
export async function redoVideo(request: RedoRequest): Promise<JobMetadata> {
  const { product } = request;
  const dataDir = storeFor(request.outputDir, request.runtime).dataDir;
  const jobId = request.jobId ?? (await listTakes(dataDir, product.id))[0]?.jobId;
  if (!jobId) {
    throw new AppStoryError("CONFIG_INVALID", `No video of ${product.id} has a kept recording yet.`, {
      hint: `Make one first: app-story ${product.id}`,
    });
  }
  const source = await loadTake(dataDir, jobId);
  if (source.product_id !== product.id) {
    throw new AppStoryError("CONFIG_INVALID", `The video ${jobId} belongs to ${source.product_id}, not ${product.id}.`);
  }

  const job = await createJob({
    outputDir: request.outputDir,
    productId: product.id,
    name: source.name,
    mode: "redo",
    objective: source.objective,
    scenarioId: null,
    logLevel: request.logLevel,
    runtime: request.runtime,
  });
  job.metadata.redo_of = jobId;
  const before = job.store.getJob(jobId);
  if (before) job.metadata.tts = before.tts; // the same spoken clips
  request.onJobCreated?.(job);
  void prepareRenderer().catch(() => undefined);

  const config = structuredClone(product.config);
  if (request.template) config.demo.template = request.template;
  const redone: LoadedProduct = { ...product, config };
  saveRecord(job, "config", { file: product.file, config, redo_of: jobId });
  saveRecord(job, "plan", source.workflow);

  let phase = "render";
  try {
    const take = await copyTakeInto(job.paths, source);
    job.metadata.recording = {
      path: take.recorded.recording.path,
      duration_s: Math.round(take.recorded.recording.durationMs / 10) / 100,
      width: take.recorded.recording.width,
      height: take.recorded.recording.height,
      engine: config.recording.engine,
    };
    await saveMetadata(job);
    job.log.info({ from: jobId, template: config.demo.template ?? "as picked for the video" }, "making the video again from its kept recording");
    return await finishJob(job, (await renderTake(job, redone, take, { onPhase: (p) => (phase = p) })).status);
  } catch (error) {
    recordError(job, error, phase);
    job.log.error({ phase, error: (error as Error).message }, "job failed");
    return finishJob(job, statusForError(error));
  }
}

/** The renderer only reads files inside the job's folder: copy the take's recording and clips there. */
async function copyTakeInto(paths: { rawRecording: string; narrationDir: string }, take: Take): Promise<Take> {
  await ensureDir(join(paths.rawRecording, ".."));
  await copyFile(take.recorded.recording.path, paths.rawRecording);
  await ensureDir(paths.narrationDir);
  const moved = new Map<string, string>();
  for (const clip of [...take.clips, ...take.recorded.placed]) {
    if (moved.has(clip.path)) continue;
    const target = join(paths.narrationDir, basename(clip.path));
    await copyFile(clip.path, target);
    moved.set(clip.path, target);
  }
  // Each language's clips in a folder of its own: their file names are the same in every language.
  for (const voice of take.languages ?? []) {
    await ensureDir(join(paths.narrationDir, voice.language));
    for (const clip of voice.clips) {
      if (moved.has(clip.path)) continue;
      const target = join(paths.narrationDir, voice.language, basename(clip.path));
      await copyFile(clip.path, target);
      moved.set(clip.path, target);
    }
  }
  const at = (path: string) => moved.get(path) ?? path;
  return {
    ...take,
    clips: take.clips.map((c) => ({ ...c, path: at(c.path) })),
    recorded: {
      ...take.recorded,
      recording: { ...take.recorded.recording, path: paths.rawRecording },
      placed: take.recorded.placed.map((c) => ({ ...c, path: at(c.path) })),
    },
    languages: take.languages?.map((l) => ({ ...l, clips: l.clips.map((c) => ({ ...c, path: at(c.path) })) })),
  };
}
