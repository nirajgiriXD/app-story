import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JobMetadataSchema, type JobMetadata, type Workflow } from "@app-story/contracts";
import { dataDirFor, redactSecrets } from "@app-story/shared";

/** What a job keeps besides its video. Text kinds hold JSON or plain text; `thumbnail` is a PNG. */
export type RecordKind =
  | "config"
  | "plan"
  | "rehearsal"
  | "narration_script"
  | "narration_clips"
  | "captions_srt"
  | "captions_vtt"
  | "execution"
  | "browser_issues"
  | "quality"
  | "log"
  | "thumbnail"
  | "visual_review";

const SCHEMA_VERSION = 2;

/** Cached AI and speech results that nobody has used for this long are deleted. */
const CACHE_DAYS = 30;

/** What the cache holds: the feature list of a product file, a narration script, a spoken clip. */
export type CacheKind = "features" | "narration_script" | "speech";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  objective   TEXT,
  mode        TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  finished_at TEXT,
  video_path  TEXT,
  ai_provider TEXT,
  ai_model    TEXT,
  voice       TEXT,
  cost_usd    REAL,
  metadata    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_product ON jobs (product_id, created_at);

CREATE TABLE IF NOT EXISTS job_records (
  job_id     TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  content    TEXT,
  data       BLOB,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, kind)
);

-- Older versions saved plans here; they are files next to the product file now.
CREATE TABLE IF NOT EXISTS plans (
  product_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  objective  TEXT NOT NULL,
  workflow   TEXT NOT NULL,
  saved_at   TEXT NOT NULL,
  PRIMARY KEY (product_id, key)
);

CREATE TABLE IF NOT EXISTS cache (
  key     TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,
  content TEXT,
  data    BLOB,
  used_at TEXT NOT NULL
);
`;

/** A stable cache key for any JSON-able inputs. */
export function cacheKey(kind: CacheKind, inputs: unknown): string {
  return `${kind}:${createHash("sha256").update(JSON.stringify(inputs)).digest("hex")}`;
}

const open = new Map<string, Store>();

/** The database that belongs to an output folder (`<parent>/.app-story/app-story.db`). */
export function storeFor(outputDir: string): Store {
  return Store.open(dataDirFor(outputDir));
}

/**
 * Everything AppStory tracks, in one SQLite file (`.app-story/app-story.db` in the user's
 * project): jobs and their metadata, every record a job produces, and the cache. Finished
 * videos live in `output/` and the saved plans next to the product files. Uses Node's
 * built-in `node:sqlite`.
 */
export class Store {
  readonly dataDir: string;
  readonly file: string;
  private readonly db: DatabaseSync;

  /** One connection per data folder, shared by the whole process. */
  static open(dataDir: string): Store {
    let store = open.get(dataDir);
    if (!store) {
      store = new Store(dataDir);
      open.set(dataDir, store);
    }
    return store;
  }

  private constructor(dataDir: string) {
    prepareDataDir(dataDir);
    this.dataDir = dataDir;
    this.file = join(dataDir, "app-story.db");
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    const cutoff = new Date(Date.now() - CACHE_DAYS * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM cache WHERE used_at < ?").run(cutoff);
  }

  // ----------------------------------------------------------------- cache

  /**
   * Results that are expensive to make and identical for identical inputs (an AI answer
   * for the same text, speech for the same line), so a re-run does not pay for them again.
   */
  getCachedText(key: string): string | undefined {
    const row = this.db.prepare("SELECT content FROM cache WHERE key = ?").get(key) as { content: string | null } | undefined;
    if (!row?.content) return undefined;
    this.touch(key);
    return row.content;
  }

  getCachedBlob(key: string): Buffer | undefined {
    const row = this.db.prepare("SELECT data FROM cache WHERE key = ?").get(key) as { data: Uint8Array | null } | undefined;
    if (!row?.data) return undefined;
    this.touch(key);
    return Buffer.from(row.data);
  }

  setCached(key: string, kind: CacheKind, value: string | Buffer): void {
    const isBlob = Buffer.isBuffer(value);
    this.db
      .prepare(
        `INSERT INTO cache (key, kind, content, data, used_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET content = excluded.content, data = excluded.data, used_at = excluded.used_at`,
      )
      .run(key, kind, isBlob ? null : redactSecrets(value as string), isBlob ? (value as Buffer) : null, new Date().toISOString());
  }

  private touch(key: string): void {
    this.db.prepare("UPDATE cache SET used_at = ? WHERE key = ?").run(new Date().toISOString(), key);
  }

  // ------------------------------------------------------------------ jobs

  /** Insert or update a job from its metadata (secrets scrubbed). `name` is the job's short name. */
  saveJob(metadata: JobMetadata, name: string): void {
    const m = redactSecrets(JobMetadataSchema.parse(metadata));
    this.db
      .prepare(
        `INSERT INTO jobs (id, product_id, name, objective, mode, status, created_at, finished_at, video_path, ai_provider, ai_model, voice, cost_usd, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           objective = excluded.objective, mode = excluded.mode, status = excluded.status,
           finished_at = excluded.finished_at, video_path = excluded.video_path,
           ai_provider = excluded.ai_provider, ai_model = excluded.ai_model, voice = excluded.voice,
           cost_usd = excluded.cost_usd, metadata = excluded.metadata`,
      )
      .run(
        m.job_id,
        m.product_id,
        name,
        m.objective,
        m.mode,
        m.status,
        m.created_at,
        m.finished_at,
        m.video?.path ?? null,
        m.ai.provider,
        m.ai.model,
        m.tts.voice ? `${m.tts.provider}/${m.tts.voice}` : m.tts.provider,
        m.usage?.estimated_cost_usd ?? null,
        JSON.stringify(m),
      );
  }

  getJob(id: string): JobMetadata | undefined {
    const row = this.db.prepare("SELECT metadata FROM jobs WHERE id = ?").get(id) as { metadata: string } | undefined;
    return row ? (JSON.parse(row.metadata) as JobMetadata) : undefined;
  }

  /** Finished jobs, newest first. */
  listJobs(options: { productId?: string; limit?: number } = {}): JobMetadata[] {
    const where = ["finished_at IS NOT NULL", ...(options.productId ? ["product_id = ?"] : [])].join(" AND ");
    const params = [...(options.productId ? [options.productId] : []), options.limit ?? -1];
    const rows = this.db.prepare(`SELECT metadata FROM jobs WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as { metadata: string }[];
    return rows.map((r) => JSON.parse(r.metadata) as JobMetadata);
  }

  /** Keep something a job produced: JSON-able values and text as `content`, buffers as `data`. */
  saveRecord(jobId: string, kind: RecordKind, value: unknown): void {
    const isBlob = Buffer.isBuffer(value);
    const content = isBlob ? null : typeof value === "string" ? redactSecrets(value) : JSON.stringify(redactSecrets(value));
    this.db
      .prepare(
        `INSERT INTO job_records (job_id, kind, content, data, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (job_id, kind) DO UPDATE SET content = excluded.content, data = excluded.data, created_at = excluded.created_at`,
      )
      .run(jobId, kind, content, isBlob ? (value as Buffer) : null, new Date().toISOString());
  }

  /** A record as text (JSON for structured kinds), or undefined. */
  getRecordText(jobId: string, kind: RecordKind): string | undefined {
    const row = this.db.prepare("SELECT content FROM job_records WHERE job_id = ? AND kind = ?").get(jobId, kind) as { content: string | null } | undefined;
    return row?.content ?? undefined;
  }

  getRecordJson<T = unknown>(jobId: string, kind: RecordKind): T | undefined {
    const text = this.getRecordText(jobId, kind);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  getRecordBlob(jobId: string, kind: RecordKind): Buffer | undefined {
    const row = this.db.prepare("SELECT data FROM job_records WHERE job_id = ? AND kind = ?").get(jobId, kind) as { data: Uint8Array | null } | undefined;
    return row?.data ? Buffer.from(row.data) : undefined;
  }

  // ----------------------------------------------------------------- plans

  /**
   * A plan saved by an older version, which kept plans here (they are files now, see
   * pipeline/plans.ts). Returned once and removed, so it can be moved to its file.
   */
  takeLegacyPlan(productId: string, key: string): Workflow | undefined {
    const row = this.db.prepare("SELECT workflow FROM plans WHERE product_id = ? AND key = ?").get(productId, key) as { workflow: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM plans WHERE product_id = ? AND key = ?").run(productId, key);
    return JSON.parse(row.workflow) as Workflow;
  }
}

/** Create the data folder, keep it out of git, and bring over a database from where older versions kept it. */
function prepareDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const ignore = join(dataDir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "# AppStory's records: never commit them.\n*\n");
  const old = join(dirname(dataDir), "engine", "data", "app-story.db");
  const now = join(dataDir, "app-story.db");
  if (existsSync(old) && !existsSync(now)) {
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(old + suffix)) renameSync(old + suffix, now + suffix);
  }
}
