import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JobMetadataSchema, type JobError, type JobMetadata, type JobStatus } from "@demoforge/contracts";
import { UsageTracker } from "@demoforge/ai";
import {
  createJobId,
  createLogger,
  ensureDir,
  redactSecrets,
  slugify,
  toDemoForgeError,
  writeJson,
  type Logger,
} from "@demoforge/shared";

export interface JobPaths {
  root: string;
  metadata: string;
  plan: string;
  scenarioDraft: string;
  quality: string;
  recordingDir: string;
  rawRecording: string;
  screenshots: string;
  narrationDir: string;
  script: string;
  narrationAudio: string;
  captionsDir: string;
  srt: string;
  vtt: string;
  videoDir: string;
  finalVideo: string;
  thumbnail: string;
  assetsDir: string;
  logsDir: string;
  executionLog: string;
  browserLog: string;
  errorsLog: string;
  runLog: string;
  trace: string;
  rehearsal: string;
}

export interface Job {
  id: string;
  paths: JobPaths;
  metadata: JobMetadata;
  log: Logger;
  usage: UsageTracker;
}

export function resolveOutputDir(dir?: string): string {
  return resolve(dir ?? process.env.DEMOFORGE_OUTPUT_DIR ?? "output");
}

export function jobPaths(root: string): JobPaths {
  const p = (...parts: string[]) => join(root, ...parts);
  return {
    root,
    metadata: p("metadata.json"),
    plan: p("plan.json"),
    scenarioDraft: p("scenario.yaml"),
    quality: p("quality.json"),
    recordingDir: p("recording"),
    rawRecording: p("recording", "raw.mp4"),
    screenshots: p("recording", "screenshots"),
    narrationDir: p("narration"),
    script: p("narration", "script.md"),
    narrationAudio: p("narration", "audio.mp3"),
    captionsDir: p("captions"),
    srt: p("captions", "subtitles.srt"),
    vtt: p("captions", "subtitles.vtt"),
    videoDir: p("video"),
    finalVideo: p("video", "final.mp4"),
    thumbnail: p("video", "thumbnail.png"),
    assetsDir: p("assets"),
    logsDir: p("logs"),
    executionLog: p("logs", "execution.json"),
    browserLog: p("logs", "browser.json"),
    errorsLog: p("logs", "errors.json"),
    runLog: p("logs", "run.log"),
    trace: p("logs", "trace.zip"),
    rehearsal: p("logs", "rehearsal.json"),
  };
}

export interface CreateJobInput {
  outputDir: string;
  productId: string;
  /** Folder name grouping jobs of the same demo (scenario id or objective slug). */
  name: string;
  mode: JobMetadata["mode"];
  objective: string | null;
  scenarioId: string | null;
  logLevel?: string;
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  const id = createJobId();
  const root = join(input.outputDir, input.productId, slugify(input.name), id);
  const paths = jobPaths(root);
  await ensureDir(paths.logsDir);
  const log = createLogger({ level: input.logLevel, file: paths.runLog }).child({ job: id });
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
  const job: Job = { id, paths, metadata, log, usage: new UsageTracker() };
  await saveMetadata(job);
  return job;
}

export async function saveMetadata(job: Job): Promise<void> {
  job.metadata.usage = job.usage.summary();
  await writeJson(job.paths.metadata, redactSecrets(JobMetadataSchema.parse(job.metadata)));
}

export function recordError(job: Job, error: unknown, phase?: string, stepId?: string): JobError {
  const e = toDemoForgeError(error);
  const entry: JobError = { code: e.code, message: e.message, hint: e.hint, phase, step_id: stepId };
  job.metadata.errors.push(redactSecrets(entry));
  return entry;
}

export async function finishJob(job: Job, status: JobStatus): Promise<JobMetadata> {
  job.metadata.status = status;
  job.metadata.finished_at = new Date().toISOString();
  await saveMetadata(job);
  if (job.metadata.errors.length) await writeJson(job.paths.errorsLog, job.metadata.errors);
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

/** Folders one level down, or none when `dir` does not exist. */
async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
}

/**
 * Finished jobs, newest first. Read from each job's own metadata.json
 * (`<output>/<product>/<demo>/<job-id>/`), so there is no separate index to keep in
 * sync: deleting a job folder also removes it from the history.
 */
export async function readHistory(outputDir: string, options: { limit?: number; productId?: string } = {}): Promise<HistoryEntry[]> {
  const products = options.productId ? [join(outputDir, options.productId)] : await subdirs(outputDir);
  const jobDirs = (await Promise.all(products.map(subdirs))).flat();
  const jobs = (await Promise.all(jobDirs.map(subdirs))).flat();
  const entries: HistoryEntry[] = [];
  await Promise.all(
    jobs.map(async (dir) => {
      const raw = await readFile(join(dir, "metadata.json"), "utf8").catch(() => undefined);
      if (!raw) return;
      let parsed;
      try {
        parsed = JobMetadataSchema.safeParse(JSON.parse(raw));
      } catch {
        return; // a half-written or hand-edited file: skip it
      }
      // Jobs still running (or killed mid-run) have no finish time yet.
      if (parsed.success && parsed.data.finished_at) entries.push(toHistoryEntry(parsed.data));
    }),
  );
  entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return options.limit ? entries.slice(0, options.limit) : entries;
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
