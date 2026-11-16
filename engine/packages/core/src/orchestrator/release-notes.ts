import { PROMPT_VERSIONS, createAIProvider, pickFeatures, UsageTracker } from "@showrun/ai";
import { FeaturePlanSchema, type AiProviderConfig, type FeaturePlan } from "@showrun/contracts";
import type { LoadedProduct } from "@showrun/products";
import { ShowrunError, createLogger, isShowrunError } from "@showrun/shared";
import type { ProviderOverrides } from "../pipeline/providers";
import { cacheKey, storeFor } from "../store/store";

export interface PickFeaturesRequest {
  product: LoadedProduct;
  logLevel?: string;
  providers?: ProviderOverrides;
  /** Output folder; its database caches the answer for an unchanged product file. */
  outputDir?: string;
  /** Ask the AI again even if this product file was read before. */
  fresh?: boolean;
}

export interface PickFeaturesResult {
  plan: FeaturePlan;
  provider: string;
  model: string;
  costUsd: number | null;
  /** True when the answer came from an earlier run with the same product file. */
  cached: boolean;
}

/**
 * Read the product file and pick the new features worth demoing from its release notes.
 * The AI keeps user-visible features and skips bug fixes, internal work and headings.
 */
export async function planFeatures(request: PickFeaturesRequest): Promise<PickFeaturesResult> {
  const { product } = request;
  if (!product.brief.trim()) {
    throw new ShowrunError("CONFIG_INVALID", `${product.file} has nothing below its settings block.`, {
      hint: `Describe the app and paste your release notes into it, or say what to show: npx showrun ${product.id} "..."`,
    });
  }
  const usage = new UsageTracker();
  const log = createLogger({ level: request.logLevel });
  const { config } = product;
  const context = { name: config.product.name, description: config.product.description, baseUrl: config.product.base_url };

  // The same product file gives the same features: reuse the earlier answer.
  const store = request.outputDir ? storeFor(request.outputDir) : undefined;
  const key = cacheKey("features", { context, brief: product.brief, prompt: PROMPT_VERSIONS["release-notes"] });
  const saved = request.fresh ? undefined : store?.getCachedText(key);
  if (saved) {
    const plan = FeaturePlanSchema.safeParse(JSON.parse(saved));
    if (plan.success && plan.data.features.length > 0) {
      log.info("features from the earlier run (product file unchanged)");
      return { plan: plan.data, provider: config.providers.ai.provider, model: config.providers.ai.model ?? "(cached)", costUsd: null, cached: true };
    }
  }

  const read = async (ai: AiProviderConfig) => {
    const deps = { usage, log };
    const provider = request.providers?.createAI ? request.providers.createAI(ai, deps) : createAIProvider(ai, deps);
    return { provider, plan: await pickFeatures({ provider, product: context, productFile: product.brief }) };
  };

  let result: Awaited<ReturnType<typeof read>>;
  try {
    result = await read(config.providers.ai);
  } catch (error) {
    const fallback = config.providers.ai_fallback;
    if (!fallback || !(isShowrunError(error) && error.code.startsWith("PROVIDER_"))) throw error;
    log.warn({ to: fallback.provider, reason: (error as Error).message }, "picking features failed; trying the fallback provider");
    result = await read(fallback);
  }

  const { plan, provider } = result;
  if (plan.features.length === 0) {
    const skipped = plan.skipped.map((s) => `\n- ${s.item} (${s.reason})`).join("");
    throw new ShowrunError("UNSUPPORTED_WORKFLOW", `Nothing new to demo in ${product.file}.${skipped}`, {
      hint: `Add release notes with user-visible features, or say what to show: npx showrun ${product.id} "..."`,
    });
  }
  store?.setCached(key, "features", JSON.stringify(plan));
  return { plan, provider: provider.name, model: provider.model, costUsd: usage.summary().estimated_cost_usd, cached: false };
}
