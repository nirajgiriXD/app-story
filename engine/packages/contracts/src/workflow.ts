import { z } from "zod";

/** Bump when the workflow file format changes in a non-compatible way. */
export const WORKFLOW_VERSION = 1 as const;

/**
 * How to find an element. Accessible locators (role + name, label, text) are preferred;
 * `css` is a last resort. At least one field must be set.
 */
export const TargetSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    placeholder: z.string().optional(),
    test_id: z.string().optional(),
    css: z.string().optional(),
    exact: z.boolean().optional(),
    /** Pick the n-th match (0-based) when several elements match. */
    nth: z.number().int().min(0).optional(),
  })
  .refine((t) => Boolean(t.role || t.name || t.label || t.text || t.placeholder || t.test_id || t.css), {
    message: "a target needs at least one of role, name, label, text, placeholder, test_id or css",
  });
export type Target = z.infer<typeof TargetSchema>;

export const EXPECTATION_TYPES = [
  "visible",
  "hidden",
  "text_present",
  "text_absent",
  "url_contains",
  "title_contains",
  "value_equals",
  "count_at_least",
  "custom",
] as const;

export const ExpectationSchema = z.object({
  type: z.enum(EXPECTATION_TYPES),
  target: TargetSchema.optional(),
  text: z.string().optional(),
  value: z.string().optional(),
  count: z.number().int().min(0).optional(),
  /** Name of a verification function exported by the product adapter (type: custom). */
  name: z.string().optional(),
  /** Plain-language description of what is verified, for logs and narration. */
  description: z.string().optional(),
});
export type Expectation = z.infer<typeof ExpectationSchema>;

export const ConditionSchema = z.object({
  type: z.enum(["visible", "not_visible", "url_contains", "text_present"]),
  target: TargetSchema.optional(),
  text: z.string().optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const STEP_ACTIONS = ["navigate", "click", "fill", "select", "check", "uncheck", "hover", "scroll", "press", "wait", "screenshot", "assert"] as const;
export const StepActionSchema = z.enum(STEP_ACTIONS);
export type StepAction = z.infer<typeof StepActionSchema>;

export const StepSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    action: StepActionSchema,
    target: TargetSchema.optional(),
    /** navigate: path or absolute URL. */
    url: z.string().optional(),
    /** fill: text to type; select: option label. Supports {{env:NAME}}. */
    value: z.string().optional(),
    /** press: key name such as Enter or Control+K. */
    key: z.string().optional(),
    /** scroll: direction and amount in pixels (or scroll target into view when a target is set). */
    direction: z.enum(["up", "down"]).optional(),
    amount: z.number().int().optional(),
    /** wait: milliseconds. */
    duration_ms: z.number().int().min(0).max(60_000).optional(),
    /** Post-condition verified right after the action. Required for assert steps. */
    expected: ExpectationSchema.optional(),
    /** Run the step only when the condition holds; otherwise it is skipped. */
    when: ConditionSchema.optional(),
    optional: z.boolean().optional(),
    timeout_ms: z.number().int().positive().optional(),
    /** Free-text hint used when the step fails during an AI-assisted run. */
    recovery: z.string().optional(),
    /** Section title shown as a chapter card in the video. */
    section: z.string().optional(),
    /** Narration for this step. When present on every step, no AI is needed for the script. */
    narration: z.string().optional(),
    /** Mask the value in logs and narration. */
    secret: z.boolean().optional(),
    /** Set false to stop the video from zooming on this step. */
    zoom: z.boolean().optional(),
  })
  .superRefine((step, ctx) => {
    const needsTarget = ["click", "fill", "select", "check", "uncheck", "hover"] as const;
    if ((needsTarget as readonly string[]).includes(step.action) && !step.target) {
      ctx.addIssue({ code: "custom", message: `${step.action} needs a target`, path: ["target"] });
    }
    if (step.action === "navigate" && !step.url) ctx.addIssue({ code: "custom", message: "navigate needs a url", path: ["url"] });
    if ((step.action === "fill" || step.action === "select") && step.value === undefined) {
      ctx.addIssue({ code: "custom", message: `${step.action} needs a value`, path: ["value"] });
    }
    if (step.action === "press" && !step.key) ctx.addIssue({ code: "custom", message: "press needs a key", path: ["key"] });
    if (step.action === "assert" && !step.expected) {
      ctx.addIssue({ code: "custom", message: "assert needs an expected outcome", path: ["expected"] });
    }
  });
export type Step = z.infer<typeof StepSchema>;

/** The video kinds (see `VideoKind` in product.ts). */
export const VIDEO_KINDS = ["whats-new", "feature", "how-to"] as const;

/**
 * The voice-over of a plan, saved in the plan file with it after a successful video, so
 * the next video of the plan (a teammate's, or one made in CI) needs no AI to write it.
 * Segment text may hold `{{@step}}` anchors (see narration's anchors.ts).
 */
export const SavedNarrationSchema = z.object({
  /** The language it is written in; another language writes it again. */
  language: z.string().min(1),
  intro: z.string(),
  segments: z.array(z.object({ step_ids: z.array(z.string()).min(1), text: z.string() })).min(1),
  outro: z.string(),
});
export type SavedNarration = z.infer<typeof SavedNarrationSchema>;

export const WorkflowSchema = z.object({
  workflow_version: z.literal(WORKFLOW_VERSION),
  id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  audience: z.string().optional(),
  summary: z.string().optional(),
  /** Generated scenarios start unapproved and must be reviewed before automated production. */
  approved: z.boolean().default(false),
  created_by: z.enum(["human", "ai"]).default("human"),
  source: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      job_id: z.string().optional(),
      created_at: z.string().optional(),
    })
    .optional(),
  /** The kind of video the plan was made for: it picks the look when the plan is replayed. */
  kind: z.enum(VIDEO_KINDS).optional(),
  setup: z.array(StepSchema).default([]),
  steps: z.array(StepSchema).min(1),
  cleanup: z.array(StepSchema).default([]),
  narration: SavedNarrationSchema.optional(),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowInput = z.input<typeof WorkflowSchema>;
