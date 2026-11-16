import { z } from "zod";

export const QualityCheckSchema = z.object({
  category: z.enum(["workflow", "recording", "audio", "video"]),
  name: z.string(),
  passed: z.boolean(),
  severity: z.enum(["error", "warning"]),
  detail: z.string().optional(),
});
export type QualityCheck = z.infer<typeof QualityCheckSchema>;

export const QualityReportSchema = z.object({
  job_id: z.string(),
  passed: z.boolean(),
  checks: z.array(QualityCheckSchema),
  generated_at: z.string(),
});
export type QualityReport = z.infer<typeof QualityReportSchema>;
