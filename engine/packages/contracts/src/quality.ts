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

/**
 * An AI's look at frames of the finished video, one per narration line. All fields are
 * required (nullable where optional) so the schema works with strict structured outputs.
 */
export const VisualReviewSchema = z.object({
  frames: z.array(
    z.object({
      index: z.number().int().describe("The frame's number, as given in the request."),
      subject_visible: z.boolean().describe("What the narration line talks about is on screen and readable."),
      text_cut_off: z.boolean().describe("Text or controls the line is about are cut off at the edge of the view."),
      caption_covers_subject: z.boolean().describe("The caption hides what the line talks about."),
      issue: z.string().nullable().describe("A short description of the problem, or null."),
    }),
  ),
});
export type VisualReview = z.infer<typeof VisualReviewSchema>;
