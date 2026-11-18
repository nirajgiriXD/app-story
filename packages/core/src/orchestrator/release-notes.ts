import { PROMPT_VERSIONS, createAIProvider, pickFeatures, UsageTracker } from "@app-story/ai";
import { FeaturePlanSchema, type AiProviderConfig, type FeaturePlan } from "@app-story/contracts";
import type { LoadedProduct } from "@app-story/products";
import { AppStoryError, createLogger, isAppStoryError, type Logger } from "@app-story/shared";
import { endStages, enterStage } from "../pipeline/stages";
import type { ProviderOverrides } from "../pipeline/providers";
import { cacheKey } from "../store/store";
import { storeFor, type Runtime } from "../runtime";

export interface PickFeaturesRequest {
  product: LoadedProduct;
  logLevel?: string;
  providers?: ProviderOverrides;
  /** Output folder; its database caches the answer for an unchanged product file. */
  outputDir?: string;
  /** Ask the AI again even if this product file was read before. */
  fresh?: boolean;
  /** Default: the process's runtime. */
  runtime?: Runtime;
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
    throw new AppStoryError("CONFIG_INVALID", `${product.file} has nothing below its settings block.`, {
      hint: `Describe the app and paste your release notes into it, or say what to show: npx app-story ${product.id} "..."`,
    });
  }
  const log = createLogger({ level: request.logLevel });
  enterStage(log, "features");
  try {
    const result = await readReleaseNotes(request, log);
    endStages(log, { ok: true });
    return result;
  } catch (error) {
    // Nothing new is an answer, not a failure: the CLI then makes the listed videos.
    endStages(log, { ok: isNothingNew(error), error: (error as Error).message.split("\n")[0] });
    throw error;
  }
}

async function readReleaseNotes(request: PickFeaturesRequest, log: Logger): Promise<PickFeaturesResult> {
  const { product } = request;
  const usage = new UsageTracker();
  const { config } = product;
  const context = { name: config.product.name, description: config.product.description, baseUrl: config.product.base_url };

  // The same product file gives the same features: reuse the earlier answer.
  const store = request.outputDir ? storeFor(request.outputDir, request.runtime) : undefined;
  const key = cacheKey("features", { context, brief: product.brief, prompt: PROMPT_VERSIONS["release-notes"] });
  const saved = request.fresh ? undefined : store?.getCachedText(key);
  if (saved) {
    const plan = FeaturePlanSchema.safeParse(JSON.parse(saved));
    if (plan.success) {
      // "Nothing new" is remembered too, so asking again costs nothing until the file changes.
      if (plan.data.features.length === 0) throw nothingNew(product, plan.data);
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
    if (!fallback || !(isAppStoryError(error) && error.code.startsWith("PROVIDER_"))) throw error;
    log.warn({ to: fallback.provider, reason: (error as Error).message }, "picking features failed; trying the fallback provider");
    result = await read(fallback);
  }

  const { plan, provider } = result;
  store?.setCached(key, "features", JSON.stringify(plan));
  if (plan.features.length === 0) throw nothingNew(product, plan);
  return { plan, provider: provider.name, model: provider.model, costUsd: usage.summary().estimated_cost_usd, cached: false };
}

/** The release notes have no new feature a viewer can see. */
export function isNothingNew(error: unknown): boolean {
  return isAppStoryError(error) && error.details?.nothingNew === true;
}

export function nothingNew(product: LoadedProduct, plan: FeaturePlan): AppStoryError {
  const skipped = plan.skipped.map((s) => `\n- ${s.item} (${s.reason})`).join("");
  const listed = product.videos?.length ? `, make the videos listed under "## Videos": npx app-story ${product.id} --videos,` : "";
  return new AppStoryError("UNSUPPORTED_WORKFLOW", `Nothing new to demo in ${product.file}.${skipped}`, {
    details: { nothingNew: true },
    hint: `Add release notes with user-visible features${listed} or say what to show: npx app-story ${product.id} "..."`,
  });
}
