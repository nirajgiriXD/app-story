import { FeaturePlanSchema, type FeaturePlan } from "@demoforge/contracts";
import type { AIProvider } from "../contracts/types";
import { loadPrompt } from "../prompts";
import { formatProductContext, type ProductContext } from "./context";

/** Release notes longer than this are cut; a demo covers a handful of features at most. */
const MAX_NOTES_CHARS = 60_000;

/**
 * Read release notes in any format and pick the user-visible features worth demoing.
 * Bug fixes, internal work and headings like "Added"/"Fixed" end up in `skipped`.
 */
export async function readReleaseNotes(input: { provider: AIProvider; product: ProductContext; notes: string }): Promise<FeaturePlan> {
  const notes = input.notes.slice(0, MAX_NOTES_CHARS).replace(/<\/?release_notes>/gi, "");
  const plan = await input.provider.generateStructuredOutput({
    system: loadPrompt("release-notes"),
    prompt: `${formatProductContext(input.product)}\n\n# Release notes\n<release_notes>\n${notes}\n</release_notes>`,
    schema: FeaturePlanSchema,
    schemaName: "feature_plan",
  });
  return {
    title: plan.title?.trim() || null,
    features: plan.features.map((f) => ({ title: f.title.trim(), details: f.details.trim() })).filter((f) => f.title),
    skipped: plan.skipped,
  };
}
