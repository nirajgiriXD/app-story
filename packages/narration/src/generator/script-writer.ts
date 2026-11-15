import { NarrationScriptSchema, type NarrationScript, type Workflow } from "@demoforge/contracts";
import { formatProductContext, loadPrompt, type AIProvider, type ProductContext } from "@demoforge/ai";

export interface ScriptRequest {
  provider: AIProvider | undefined;
  workflow: Workflow;
  product: ProductContext;
  language: string;
  targetDurationS: number;
  audience?: string;
}

const WORDS_PER_SECOND = 2.5;

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
        outro: `That's how to ${workflow.title.charAt(0).toLowerCase()}${workflow.title.slice(1)}.`,
      },
    };
  }
  if (!request.provider) {
    throw new Error("Narration needs an AI provider unless every scenario step has `narration` text.");
  }

  const steps = workflow.steps
    .map((s) => `- ${s.id} [${s.action}${s.section ? `, section "${s.section}"` : ""}] ${s.secret ? "(secret value) " : ""}${s.description}${s.narration ? ` — author note: ${s.narration}` : ""}`)
    .join("\n");
  const words = Math.round(request.targetDurationS * WORDS_PER_SECOND * 0.75);
  const prompt = [
    formatProductContext(request.product),
    `# Video\nTitle: ${workflow.title}\nObjective: ${workflow.objective}${workflow.summary ? `\nSummary: ${workflow.summary}` : ""}`,
    `# Audience\n${request.audience ?? workflow.audience ?? "Users of the product"}`,
    `# Verified steps, in order\n${steps}`,
    `# Requirements\nLanguage: ${request.language}\nTotal words: about ${words}.`,
  ].join("\n\n");

  const script = await request.provider.generateStructuredOutput({
    system: loadPrompt("narration"),
    prompt,
    schema: NarrationScriptSchema,
    schemaName: "narration_script",
  });
  return { script: normalizeScript(script, workflow.steps.map((s) => s.id)), source: "ai" };
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
    ids.forEach((id) => claimed.add(id));
    segments.push({ step_ids: ids, text: segment.text.trim() });
  }
  segments.sort((a, b) => (position.get(a.step_ids[0] as string) as number) - (position.get(b.step_ids[0] as string) as number));

  // Any step the model skipped joins the segment before it (or the first one).
  for (const id of stepIds) {
    if (claimed.has(id)) continue;
    const idx = position.get(id) as number;
    const host =
      [...segments].reverse().find((s) => (position.get(s.step_ids[0] as string) as number) < idx) ?? segments[0];
    if (host) host.step_ids.push(id);
    else segments.push({ step_ids: [id], text: "" });
    host?.step_ids.sort((a, b) => (position.get(a) as number) - (position.get(b) as number));
  }
  return { intro: script.intro.trim(), outro: script.outro.trim(), segments: segments.filter((s) => s.text || s.step_ids.length) };
}
