import { z } from "zod";

export const BoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export type Box = z.infer<typeof BoxSchema>;

export const StepStatusSchema = z.enum(["passed", "failed", "skipped"]);

/**
 * A native dropdown (`<select>`) as it was opened on camera. The browser draws its list
 * outside the page, so the recording never shows it; the video draws it from this.
 */
export const MenuShownSchema = z.object({
  options: z.array(z.string()),
  /** The option selected before and after. */
  from: z.number().int(),
  to: z.number().int(),
  /** When the list opened and closed (same clock as the step). */
  opened_ms: z.number(),
  closed_ms: z.number(),
});
export type MenuShown = z.infer<typeof MenuShownSchema>;
export { menuLayout } from "./menu";

export const StepResultSchema = z.object({
  step_id: z.string(),
  action: z.string(),
  description: z.string(),
  status: StepStatusSchema,
  /** Milliseconds since the recording started (or since the run started when not recording). */
  started_ms: z.number(),
  ended_ms: z.number(),
  attempts: z.number().int(),
  verified: z.boolean(),
  url_after: z.string().optional(),
  /** Element box in viewport CSS pixels, used for zoom and cursor effects. */
  box: BoxSchema.optional(),
  /** The area the element belongs to (its form, card, dialog or table), for framing the shot. */
  region: BoxSchema.optional(),
  /** Where the verified outcome is on screen (the message, the new row), measured after the check. */
  result_box: BoxSchema.optional(),
  error: z.string().optional(),
  error_code: z.string().optional(),
  screenshot: z.string().optional(),
  section: z.string().optional(),
  /** A native dropdown opened by this step, for the video to draw. */
  menu: MenuShownSchema.optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const CursorPointSchema = z.object({
  t: z.number(),
  x: z.number(),
  y: z.number(),
  click: z.boolean().optional(),
  /** The pointer's shape from here on, as the page sets it: a hand over links and buttons, a text bar over text fields. */
  shape: z.enum(["arrow", "hand", "text"]).optional(),
});
export type CursorPoint = z.infer<typeof CursorPointSchema>;

export const BrowserIssueSchema = z.object({
  kind: z.enum(["console_error", "page_error", "request_failed", "blocked_navigation", "http_error"]),
  message: z.string(),
  url: z.string().optional(),
  at: z.string(),
});
export type BrowserIssue = z.infer<typeof BrowserIssueSchema>;

export const ExecutionReportSchema = z.object({
  phase: z.enum(["rehearsal", "recording", "dry_run"]),
  ok: z.boolean(),
  steps: z.array(StepResultSchema),
  cursor: z.array(CursorPointSchema),
  issues: z.array(BrowserIssueSchema),
  /** Every change of the page's address, when it happened (ms on the recording clock). */
  navigations: z.array(z.object({ t: z.number(), url: z.string() })).optional(),
  final_url: z.string().optional(),
  duration_ms: z.number(),
});
export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;
