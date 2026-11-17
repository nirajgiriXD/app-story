import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AudioClip, VideoKind, Workflow } from "@app-story/contracts";
import { AppStoryError, ensureDir, fileExists } from "@app-story/shared";
import type { Job } from "../job-manager/job";
import type { RecordingOutcome } from "./record";

/**
 * A take is everything a video is made from once the app has been recorded: the raw
 * recording, the spoken clips, the plan and the recording's timeline. It is kept after a
 * video, in `.app-story/takes/<job-id>/`, so the video can be made again with another
 * look, logo, colour, music or captions setting (`app-story redo`) without opening the
 * app or calling the AI. Only the newest few takes of each product are kept.
 */
export interface Take {
  job_id: string;
  product_id: string;
  /** The job's short name (also the saved plan's name). */
  name: string;
  objective: string | null;
  kind: VideoKind | null;
  workflow: Workflow;
  clips: AudioClip[];
  recorded: RecordingOutcome;
  silent: boolean;
}

/** How many takes are kept per product. */
export const TAKES_PER_PRODUCT = 5;

const TAKE_FILE = "take.json";
const RECORDING = "recording.mp4";

export function takesDir(dataDir: string): string {
  return join(dataDir, "takes");
}

export interface KeptTake {
  dir: string;
  /** The name in the take folder of a job file that was kept (the recording or a clip). */
  nameOf(path: string): string | undefined;
}

/** Copy a job's recording and clips into its take folder, then drop the oldest takes of the product. */
export async function keepTake(job: Job, take: Take): Promise<KeptTake> {
  const dir = join(takesDir(job.store.dataDir), job.id);
  await ensureDir(dir);
  await copyFile(take.recorded.recording.path, join(dir, RECORDING));
  const clipFiles = new Map<string, string>();
  for (const clip of take.clips) {
    if (clipFiles.has(clip.path)) continue;
    const name = `clip-${clipFiles.size}-${basename(clip.path)}`;
    await copyFile(clip.path, join(dir, name));
    clipFiles.set(clip.path, name);
  }
  // Paths are stored relative to the take folder, so the folder can be moved.
  const relative = (path: string) => clipFiles.get(path) ?? basename(path);
  const stored: Take = {
    ...take,
    job_id: job.id,
    clips: take.clips.map((c) => ({ ...c, path: relative(c.path) })),
    recorded: {
      ...take.recorded,
      recording: { ...take.recorded.recording, path: RECORDING },
      placed: take.recorded.placed.map((c) => ({ ...c, path: relative(c.path) })),
    },
  };
  await writeFile(join(dir, TAKE_FILE), JSON.stringify(stored));
  await pruneTakes(job.store.dataDir, take.product_id);
  const byFile = new Map([[resolve(take.recorded.recording.path), RECORDING], ...[...clipFiles].map(([path, name]) => [resolve(path), name] as const)]);
  return { dir, nameOf: (path) => byFile.get(resolve(path)) };
}

/** A kept take, with absolute paths to its files. */
export async function loadTake(dataDir: string, jobId: string): Promise<Take & { dir: string }> {
  const dir = join(takesDir(dataDir), jobId);
  const file = join(dir, TAKE_FILE);
  if (!(await fileExists(file))) {
    throw new AppStoryError("CONFIG_INVALID", `There is no kept recording for the video ${jobId}.`, {
      hint: `Only the ${TAKES_PER_PRODUCT} newest videos of each product keep their recording. See \`npx app-story history\`.`,
    });
  }
  const take = JSON.parse(await readFile(file, "utf8")) as Take;
  const abs = (path: string) => join(dir, path);
  return {
    ...take,
    dir,
    clips: take.clips.map((c) => ({ ...c, path: abs(c.path) })),
    recorded: {
      ...take.recorded,
      recording: { ...take.recorded.recording, path: abs(take.recorded.recording.path) },
      placed: take.recorded.placed.map((c) => ({ ...c, path: abs(c.path) })),
    },
  };
}

/** The job ids of a product's kept takes, newest first (job ids start with their time). */
export async function listTakes(dataDir: string, productId?: string): Promise<{ jobId: string; productId: string }[]> {
  const ids = (await readdir(takesDir(dataDir)).catch(() => [] as string[])).sort().reverse();
  const takes: { jobId: string; productId: string }[] = [];
  for (const jobId of ids) {
    const text = await readFile(join(takesDir(dataDir), jobId, TAKE_FILE), "utf8").catch(() => undefined);
    if (!text) continue;
    const owner = (JSON.parse(text) as Pick<Take, "product_id">).product_id;
    if (!productId || owner === productId) takes.push({ jobId, productId: owner });
  }
  return takes;
}

async function pruneTakes(dataDir: string, productId: string): Promise<void> {
  const old = (await listTakes(dataDir, productId)).slice(TAKES_PER_PRODUCT);
  for (const { jobId } of old) await rm(join(takesDir(dataDir), jobId), { recursive: true, force: true, maxRetries: 3 });
}
