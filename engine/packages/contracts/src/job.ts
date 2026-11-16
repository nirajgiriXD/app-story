import { z } from "zod";

/** Every job ends in exactly one of these outcomes. */
export const JOB_STATUSES = [
  "running",
  "success",
  "success_with_warnings",
  "recoverable_failure",
  "workflow_failure",
  "application_unavailable",
  "authentication_failure",
  "unsupported_workflow",
  "failed",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const UsageSummarySchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cached_input_tokens: z.number(),
  requests: z.number(),
  estimated_cost_usd: z.number().nullable(),
  by_model: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      input_tokens: z.number(),
      output_tokens: z.number(),
      cached_input_tokens: z.number(),
      requests: z.number(),
      estimated_cost_usd: z.number().nullable(),
    }),
  ),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const ProviderAttemptSchema = z.object({
  phase: z.string(),
  provider: z.string(),
  model: z.string(),
  outcome: z.enum(["success", "failed"]),
  error: z.string().optional(),
  fallback: z.boolean(),
  at: z.string(),
});
export type ProviderAttempt = z.infer<typeof ProviderAttemptSchema>;

export const JobErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  step_id: z.string().optional(),
  phase: z.string().optional(),
});
export type JobError = z.infer<typeof JobErrorSchema>;

export const JobMetadataSchema = z.object({
  job_id: z.string(),
  product_id: z.string(),
  scenario_id: z.string().nullable(),
  /** guided: planned by the AI; scenario: replayed a saved plan; redo: made again from a kept recording. */
  mode: z.enum(["guided", "scenario", "discovery", "dry_run", "redo"]),
  objective: z.string().nullable(),
  /** For a redo: the video whose recording was used. */
  redo_of: z.string().nullable().optional(),
  status: JobStatusSchema,
  created_at: z.string(),
  finished_at: z.string().nullable(),
  output_dir: z.string(),
  ai: z.object({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    fallback_configured: z.boolean(),
    fallback_used: z.boolean(),
    attempts: z.array(ProviderAttemptSchema),
  }),
  tts: z.object({ provider: z.string().nullable(), voice: z.string().nullable(), model: z.string().nullable() }),
  workflow_version: z.number().nullable(),
  recording: z.object({ path: z.string(), duration_s: z.number(), width: z.number(), height: z.number(), engine: z.string() }).nullable(),
  video: z.object({ path: z.string(), thumbnail: z.string().nullable(), duration_s: z.number() }).nullable(),
  usage: UsageSummarySchema.nullable(),
  quality: z.object({ passed: z.boolean(), errors: z.number(), warnings: z.number() }).nullable(),
  approval: z.object({ status: z.enum(["pending_review", "approved", "rejected"]), note: z.string().optional() }),
  errors: z.array(JobErrorSchema),
  warnings: z.array(z.string()),
});
export type JobMetadata = z.infer<typeof JobMetadataSchema>;
