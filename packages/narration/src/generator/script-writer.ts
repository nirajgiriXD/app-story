import { NarrationScriptSchema, type NarrationScript, type Step, type Tone, type VideoKind, type Workflow } from "@app-story/contracts";
import { PHASE_EFFORT, formatProductContext, loadPrompt, type AIProvider, type ProductContext } from "@app-story/ai";

export interface ScriptRequest {
  provider: AIProvider | undefined;
  workflow: Workflow;
  product: ProductContext;
  language: string;
  /** The longest the video should be. */
  targetDurationS: number;
  audience?: string;
  kind?: VideoKind;
  /** How the script sounds. Default: calm. */
  tone?: Tone;
  /** About how long each step is on screen (ms), by step id. */
  stepTimesMs?: Record<string, number>;
}

const WORDS_PER_SECOND = 2.5;

/** How each tone (`tone:` in the product file) is written. */
export const TONE_GUIDANCE: Record<Tone, string> = {
  calm: "Calm and clear, like a product specialist walking a customer through the app. No exclamation marks, no hype.",
  friendly: "Warm and upbeat, like a teammate showing a feature they love. Light enthusiasm; at most one exclamation mark in the whole script.",
  energetic:
    "Confident and punchy, like a product launch video. Lead with the benefit, short sentences, vivid verbs. Make the intro a hook of a few words: the problem it ends or the promise it keeps. End with a clear invitation to try it.",
};

const KIND_GUIDANCE: Record<VideoKind, string> = {
  "whats-new": "An announcement of what is new in this release: present each feature as something the viewer can now do.",
  feature: "A spotlight on one feature: what it is for and the value it brings, shown end to end.",
  "how-to": "A tutorial: a clear sequence the viewer can repeat on their own (first, then, finally).",
};

/** The step as the script writer sees it: what happens, what is typed, what it proves, how long it lasts. */
function describeForScript(step: Step, ms: number | undefined): string {
  const parts = [`- ${step.id} [${step.action}${step.section ? `, section "${step.section}"` : ""}]`, step.description];
  const hidden = step.secret || /\{\{\s*env:/.test(step.value ?? "");
  if (step.value !== undefined && (step.action === "fill" || step.action === "select")) {
    parts.push(hidden ? "(secret value, never say it)" : `- value: "${step.value}"`);
  }
  if (step.expected) {
    const proof = [step.expected.description, step.expected.text && `"${step.expected.text}"`].filter(Boolean).join(" ");
    if (proof) parts.push(`- shows: ${proof}`);
  }
  if (step.narration) parts.push(`- author note: ${step.narration}`);
  if (ms) parts.push(`(~${(ms / 1000).toFixed(1)}s on screen)`);
  return parts.join(" ");
}

/**
 * Narration comes from the verified workflow only. When the scenario author wrote
 * narration for every step, it is used as-is and no AI call is made.
 */
export async function writeNarrationScript(request: ScriptRequest): Promise<{ script: NarrationScript; source: "scenario" | "ai" }> {
  const { workflow } = request;
  if (workflow.steps.every((s) => s.narration)) {
    return {
      source: "scenario",
      script: {
        intro: workflow.summary ?? workflow.objective,
        segments: workflow.steps.map((s) => ({ step_ids: [s.id], text: s.narration as string })),
        outro: closingLine(workflow),
      },
    };
  }
  if (!request.provider) {
    throw new Error("Narration needs an AI provider unless every scenario step has `narration` text.");
  }

  const times = request.stepTimesMs ?? {};
  const steps = workflow.steps.map((s) => describeForScript(s, times[s.id])).join("\n");
  const words = segmentWordBudget(workflow.steps, times, request.targetDurationS);
  const prompt = [
    formatProductContext(request.product),
    `# Video\nTitle: ${workflow.title}\nObjective: ${workflow.objective}${workflow.summary ? `\nSummary: ${workflow.summary}` : ""}`,
    request.kind ? `# Kind of video\n${KIND_GUIDANCE[request.kind]}` : "",
    `# Tone\n${TONE_GUIDANCE[request.tone ?? "calm"]}`,
    `# Audience\n${request.audience ?? workflow.audience ?? "Users of the product"}`,
    `# Verified steps, in order\n${steps}`,
    `# Requirements\nLanguage: ${request.language}\nSegments: about ${words} words in total, sized to the steps they cover (see Length).\nIntro: at most 25 words. Outro: at most 15 words.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const script = await request.provider.generateStructuredOutput({
    system: loadPrompt("narration"),
    prompt,
    schema: NarrationScriptSchema,
    schemaName: "narration_script",
    effort: PHASE_EFFORT.narration,
  });
  return {
    script: normalizeScript(
      script,
      workflow.steps.map((s) => s.id),
    ),
    source: "ai",
  };
}

/**
 * The closing line of a scenario without AI. "That's how to …" only reads well with a verb,
 * so it is used when the objective says "how to <verb> …"; any title works with "That's it for".
 */
export function closingLine(workflow: Pick<Workflow, "title" | "objective">): string {
  const howTo = /^(?:demonstrate|show|explain)?\s*how\s+to\s+(.+?)[.!]?$/i.exec(workflow.objective.trim());
  if (howTo?.[1]) return `That's how to ${howTo[1]}.`;
  const title = workflow.title.trim().replace(/[.!]$/, "");
  return `That's it for ${title.charAt(0).toLowerCase()}${title.slice(1)}.`;
}

/**
 * Words for all segments together: about as long to say as the steps take on screen, so the
 * recording never stands still waiting for the voice. Never more than the video's length allows.
 */
export function segmentWordBudget(steps: readonly Step[], stepTimesMs: Record<string, number>, maxDurationS: number): number {
  const ceiling = Math.round(maxDurationS * WORDS_PER_SECOND * 0.75);
  const onScreenS = steps.reduce((sum, s) => sum + (stepTimesMs[s.id] ?? 0), 0) / 1000;
  if (onScreenS === 0) return ceiling;
  // A little over the action time is fine: the camera holds on each result for a moment.
  const fitted = Math.max(onScreenS * WORDS_PER_SECOND * 1.15, steps.length * 6);
  return Math.round(Math.min(ceiling, fitted));
}

/**
 * Make sure segments cover every step exactly once and in order, repairing small
 * mistakes from the model instead of failing the job.
 */
export function normalizeScript(script: NarrationScript, stepIds: readonly string[]): NarrationScript {
  const position = new Map(stepIds.map((id, i) => [id, i]));
  const claimed = new Set<string>();
  const segments: { step_ids: string[]; text: string }[] = [];

  for (const segment of script.segments) {
    const ids = segment.step_ids.filter((id) => position.has(id) && !claimed.has(id));
    if (ids.length === 0) {
      // Text without valid steps is attached to the previous segment.
      const prev = segments[segments.length - 1];
      if (prev) prev.text = `${prev.text} ${segment.text}`.trim();
      continue;
    }
    ids.sort((a, b) => (position.get(a) as number) - (position.get(b) as number));
    for (const id of ids) claimed.add(id);
    segments.push({ step_ids: ids, text: segment.text.trim() });
  }
  segments.sort((a, b) => (position.get(a.step_ids[0] as string) as number) - (position.get(b.step_ids[0] as string) as number));

  // Any step the model skipped joins the segment before it (or the first one).
  for (const id of stepIds) {
    if (claimed.has(id)) continue;
    const idx = position.get(id) as number;
    const host = [...segments].reverse().find((s) => (position.get(s.step_ids[0] as string) as number) < idx) ?? segments[0];
    if (host) host.step_ids.push(id);
    else segments.push({ step_ids: [id], text: "" });
    host?.step_ids.sort((a, b) => (position.get(a) as number) - (position.get(b) as number));
  }
  return { intro: script.intro.trim(), outro: script.outro.trim(), segments: segments.filter((s) => s.text || s.step_ids.length) };
}
