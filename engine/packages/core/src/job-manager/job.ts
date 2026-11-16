import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JobError, JobMetadata, JobStatus } from "@demoforge/contracts";
import { UsageTracker } from "@demoforge/ai";
import { createJobId, createLogger, dataDirFor, ensureDir, redactSecrets, slugify, toDemoForgeError, type Logger } from "@demoforge/shared";
import { Store, type RecordKind } from "../store/store";

/**
 * Scratch files of a running job, in `engine/data/work/<job-id>-<name>/`. Only the finished
 * video leaves this folder (to `output/`); everything worth keeping goes into the database.
 * The folder is deleted when the job succeeds and kept for troubleshooting when it fails.
 */
export interface JobPaths {
  root: string;
  recordingDir: string;
  rawRecording: string;
  screenshots: string;
  narrationDir: string;
  videoDir: string;
  finalVideo: string;
  thumbnail: string;
  assetsDir: string;
  logsDir: string;
  trace: string;
}

export interface Job {
  id: string;
  /** Short name, used for the video file and the saved plan. */
  name: string;
  /** Where the finished video goes: `<output>/<product>/`. */
  outputDir: string;
  paths: JobPaths;
  metadata: JobMetadata;
  log: Logger;
  usage: UsageTracker;
  store: Store;
  /** The job's log lines (JSON), saved to the database when the job finishes. */
  logLines: string[];
}

export function jobPaths(root: string): JobPaths {
  const p = (...parts: string[]) => join(root, ...parts);
  return {
    root,
    recordingDir: p("recording"),
    rawRecording: p("recording", "raw.mp4"),
    screenshots: p("recording", "screenshots"),
    narrationDir: p("narration"),
    videoDir: p("video"),
    finalVideo: p("video", "final.mp4"),
    thumbnail: p("video", "thumbnail.png"),
    assetsDir: p("assets"),
    logsDir: p("logs"),
    trace: p("logs", "trace.zip"),
  };
}

export interface CreateJobInput {
  /** The output folder (videos only); the database is in `engine/data/` next to it. */
  outputDir: string;
  productId: string;
  /** Short name of the demo, used for the video file name. */
  name: string;
  mode: JobMetadata["mode"];
  objective: string | null;
  scenarioId: string | null;
  logLevel?: string;
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  const id = createJobId();
  const name = slugify(input.name);
  const dataDir = dataDirFor(input.outputDir);
  const root = join(dataDir, "work", `${id}-${name}`);
  const paths = jobPaths(root);
  await ensureDir(paths.logsDir);
  const logLines: string[] = [];
  const log = createLogger({ level: input.logLevel, collect: logLines }).child({ job: id });
  const metadata: JobMetadata = {
    job_id: id,
    product_id: input.productId,
    scenario_id: input.scenarioId,
    mode: input.mode,
    objective: input.objective,
    status: "running",
    created_at: new Date().toISOString(),
    finished_at: null,
    output_dir: root,
    ai: { provider: null, model: null, fallback_configured: false, fallback_used: false, attempts: [] },
    tts: { provider: null, voice: null, model: null },
    workflow_version: null,
    recording: null,
    video: null,
    usage: null,
    quality: null,
    approval: { status: "pending_review" },
    errors: [],
    warnings: [],
  };
  const job: Job = { id, name, outputDir: input.outputDir, paths, metadata, log, usage: new UsageTracker(), store: Store.open(dataDir), logLines };
  await saveMetadata(job);
  return job;
}

export async function saveMetadata(job: Job): Promise<void> {
  job.metadata.usage = job.usage.summary();
  job.store.saveJob(job.metadata, job.name);
}

/** Keep something the job produced in the database (JSON-able value, text, or a Buffer). */
export function saveRecord(job: Job, kind: RecordKind, value: unknown): void {
  job.store.saveRecord(job.id, kind, value);
}

export function recordError(job: Job, error: unknown, phase?: string, stepId?: string): JobError {
  const e = toDemoForgeError(error);
  const entry: JobError = { code: e.code, message: e.message, hint: e.hint, phase, step_id: stepId };
  job.metadata.errors.push(redactSecrets(entry));
  return entry;
}

/** Move the rendered video to `<output>/<product>/<job-id>-<name>.mp4`: the only file a job leaves behind. */
export async function deliverVideo(job: Job): Promise<string> {
  const dest = join(job.outputDir, job.metadata.product_id, `${job.id}-${job.name}.mp4`);
  await mkdir(dirname(dest), { recursive: true });
  await rename(job.paths.finalVideo, dest).catch(async () => {
    // Different drives: copy instead.
    await copyFile(job.paths.finalVideo, dest);
  });
  if (job.metadata.video) job.metadata.video.path = dest;
  return dest;
}

const SUCCESS = new Set<JobStatus>(["success", "success_with_warnings"]);

/**
 * Record the outcome and the log in the database. A successful job's scratch folder is
 * deleted; a failed one's is kept (raw recording, screenshots, trace) for troubleshooting.
 */
export async function finishJob(job: Job, status: JobStatus): Promise<JobMetadata> {
  job.metadata.status = status;
  job.metadata.finished_at = new Date().toISOString();
  job.metadata.usage = job.usage.summary();
  if (SUCCESS.has(status)) {
    await rm(job.paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error: Error) =>
      job.log.warn({ error: error.message }, "could not delete the job's scratch folder"),
    );
  }
  saveRecord(job, "log", job.logLines.join(""));
  await saveMetadata(job);
  return job.metadata;
}

// ----------------------------------------------------------------- history

export interface HistoryEntry {
  job_id: string;
  product_id: string;
  scenario_id: string | null;
  mode: string;
  objective: string | null;
  status: string;
  created_at: string;
  finished_at: string | null;
  ai: string | null;
  video: string | null;
  output_dir: string;
  cost_usd: number | null;
}

/** Finished jobs, newest first, from the database next to `outputDir`. */
export async function readHistory(outputDir: string, options: { limit?: number; productId?: string } = {}): Promise<HistoryEntry[]> {
  return Store.open(dataDirFor(outputDir)).listJobs(options).map(toHistoryEntry);
}

function toHistoryEntry(m: JobMetadata): HistoryEntry {
  return {
    job_id: m.job_id,
    product_id: m.product_id,
    scenario_id: m.scenario_id,
    mode: m.mode,
    objective: m.objective,
    status: m.status,
    created_at: m.created_at,
    finished_at: m.finished_at,
    ai: m.ai.provider ? `${m.ai.provider}/${m.ai.model}` : null,
    video: m.video?.path ?? null,
    output_dir: m.output_dir,
    cost_usd: m.usage?.estimated_cost_usd ?? null,
  };
}
