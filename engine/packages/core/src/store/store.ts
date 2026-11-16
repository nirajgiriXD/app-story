import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JobMetadataSchema, type JobMetadata, type Workflow } from "@demoforge/contracts";
import { dataDirFor, redactSecrets } from "@demoforge/shared";

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
  | "thumbnail";

const SCHEMA_VERSION = 1;

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

CREATE TABLE IF NOT EXISTS plans (
  product_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  objective  TEXT NOT NULL,
  workflow   TEXT NOT NULL,
  saved_at   TEXT NOT NULL,
  PRIMARY KEY (product_id, key)
);
`;

const open = new Map<string, Store>();

/** The database that belongs to an output folder (`<parent>/engine/data/demoforge.db`). */
export function storeFor(outputDir: string): Store {
  return Store.open(dataDirFor(outputDir));
}

/**
 * Everything DemoForge tracks, in one SQLite file (`engine/data/demoforge.db`): jobs and
 * their metadata, every record a job produces, and the saved plans. Only finished videos
 * live outside it, in `output/`. Uses Node's built-in `node:sqlite`.
 */
export class Store {
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
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "demoforge.db");
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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

  getPlan(productId: string, key: string): { objective: string; workflow: Workflow } | undefined {
    const row = this.db.prepare("SELECT objective, workflow FROM plans WHERE product_id = ? AND key = ?").get(productId, key) as
      | { objective: string; workflow: string }
      | undefined;
    return row ? { objective: row.objective, workflow: JSON.parse(row.workflow) as Workflow } : undefined;
  }

  savePlan(productId: string, key: string, workflow: Workflow): void {
    this.db
      .prepare(
        `INSERT INTO plans (product_id, key, objective, workflow, saved_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (product_id, key) DO UPDATE SET objective = excluded.objective, workflow = excluded.workflow, saved_at = excluded.saved_at`,
      )
      .run(productId, key, workflow.objective, JSON.stringify(workflow), new Date().toISOString());
  }

  deletePlan(productId: string, key: string): void {
    this.db.prepare("DELETE FROM plans WHERE product_id = ? AND key = ?").run(productId, key);
  }

  countPlans(productId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM plans WHERE product_id = ?").get(productId) as { n: number };
    return Number(row.n);
  }
}
