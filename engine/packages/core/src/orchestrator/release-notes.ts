import { createAIProvider, pickFeatures, UsageTracker } from "@demoforge/ai";
import type { AiProviderConfig, FeaturePlan } from "@demoforge/contracts";
import type { LoadedProduct } from "@demoforge/products";
import { DemoForgeError, createLogger, isDemoForgeError } from "@demoforge/shared";
import type { ProviderOverrides } from "../pipeline/providers";

export interface PickFeaturesRequest {
  product: LoadedProduct;
  logLevel?: string;
  providers?: ProviderOverrides;
}

export interface PickFeaturesResult {
  plan: FeaturePlan;
  provider: string;
  model: string;
  costUsd: number | null;
}

/**
 * Read the product file and pick the new features worth demoing from its release notes.
 * The AI keeps user-visible features and skips bug fixes, internal work and headings.
 */
export async function planFeatures(request: PickFeaturesRequest): Promise<PickFeaturesResult> {
  const { product } = request;
  if (!product.brief.trim()) {
    throw new DemoForgeError("CONFIG_INVALID", `${product.file} has nothing below its settings block.`, {
      hint: `Describe the app and paste your release notes into it, or say what to show: npx demoforge ${product.id} "..."`,
    });
  }
  const usage = new UsageTracker();
  const log = createLogger({ level: request.logLevel });
  const { config } = product;
  const context = { name: config.product.name, description: config.product.description, baseUrl: config.product.base_url };

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
    if (!fallback || !(isDemoForgeError(error) && error.code.startsWith("PROVIDER_"))) throw error;
    log.warn({ to: fallback.provider, reason: (error as Error).message }, "picking features failed; trying the fallback provider");
    result = await read(fallback);
  }

  const { plan, provider } = result;
  if (plan.features.length === 0) {
    const skipped = plan.skipped.map((s) => `\n- ${s.item} (${s.reason})`).join("");
    throw new DemoForgeError("UNSUPPORTED_WORKFLOW", `Nothing new to demo in ${product.file}.${skipped}`, {
      hint: `Add release notes with user-visible features, or say what to show: npx demoforge ${product.id} "..."`,
    });
  }
  return { plan, provider: provider.name, model: provider.model, costUsd: usage.summary().estimated_cost_usd };
}
