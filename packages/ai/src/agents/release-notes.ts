import { FeaturePlanSchema, type FeaturePlan } from "@app-story/contracts";
import { PHASE_EFFORT, type AIProvider } from "../contracts/types";
import { loadPrompt } from "../prompts";
import { formatProductContext, type ProductContext } from "./context";

/** Longer product files are cut; a demo covers a handful of features at most. */
const MAX_FILE_CHARS = 60_000;

/**
 * Read a product file (description, tips, release notes in any format) and pick the new
 * user-visible features worth demoing. Bug fixes, internal work and headings like
 * "Added"/"Fixed" end up in `skipped`; the product description is background, not a feature.
 */
export async function pickFeatures(input: { provider: AIProvider; product: Omit<ProductContext, "brief">; productFile: string }): Promise<FeaturePlan> {
  const text = input.productFile.slice(0, MAX_FILE_CHARS).replace(/<\/?product_file>/gi, "");
  const plan = await input.provider.generateStructuredOutput({
    system: loadPrompt("release-notes"),
    prompt: `${formatProductContext(input.product)}\n\n# Product file\n<product_file>\n${text}\n</product_file>`,
    schema: FeaturePlanSchema,
    schemaName: "feature_plan",
    effort: PHASE_EFFORT.features,
  });
  return {
    title: plan.title?.trim() || null,
    features: plan.features.map((f) => ({ title: f.title.trim(), details: f.details.trim() })).filter((f) => f.title),
    skipped: plan.skipped,
  };
}
