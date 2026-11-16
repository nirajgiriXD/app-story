import { createAIProvider, readReleaseNotes, UsageTracker } from "@demoforge/ai";
import type { AiProviderConfig, FeaturePlan } from "@demoforge/contracts";
import { defaultFeaturesPath, loadReleaseNotes, type LoadedProduct, type ReleaseNotes } from "@demoforge/products";
import { DemoForgeError, createLogger, isDemoForgeError } from "@demoforge/shared";
import type { ProviderOverrides } from "../pipeline/providers";
import { productContext } from "../pipeline/rehearse";

export interface ReleaseNotesRequest {
  product: LoadedProduct;
  /** Defaults to products/<id>/features.md. */
  file?: string;
  logLevel?: string;
  providers?: ProviderOverrides;
}

export interface ReleaseNotesResult {
  notes: ReleaseNotes;
  plan: FeaturePlan;
  provider: string;
  model: string;
  costUsd: number | null;
}

/**
 * Turn release notes in any format into the list of features to demo. The AI keeps
 * user-visible features and skips bug fixes, internal work and section headings.
 */
export async function planFromReleaseNotes(request: ReleaseNotesRequest): Promise<ReleaseNotesResult> {
  const { product } = request;
  const notes = await loadReleaseNotes(request.file ?? defaultFeaturesPath(product));
  const usage = new UsageTracker();
  const log = createLogger({ level: request.logLevel });
  // The notes are passed on their own, so leave them out of the product context.
  const context = productContext({ ...product, features: undefined });

  const read = async (config: AiProviderConfig) => {
    const deps = { usage, log };
    const provider = request.providers?.createAI ? request.providers.createAI(config, deps) : createAIProvider(config, deps);
    return { provider, plan: await readReleaseNotes({ provider, product: context, notes: notes.content }) };
  };

  let result: Awaited<ReturnType<typeof read>>;
  try {
    result = await read(product.config.providers.ai);
  } catch (error) {
    const fallback = product.config.providers.ai_fallback;
    if (!fallback || !(isDemoForgeError(error) && error.code.startsWith("PROVIDER_"))) throw error;
    log.warn({ to: fallback.provider, reason: (error as Error).message }, "reading release notes failed; trying the fallback provider");
    result = await read(fallback);
  }

  const { plan, provider } = result;
  if (plan.features.length === 0) {
    const skipped = plan.skipped.map((s) => `\n- ${s.item} (${s.reason})`).join("");
    throw new DemoForgeError("UNSUPPORTED_WORKFLOW", `Nothing to demo in ${notes.file}: no user-visible features found.${skipped}`, {
      hint: "Release notes with only bug fixes or internal changes have nothing to show on screen.",
    });
  }
  return { notes, plan, provider: provider.name, model: provider.model, costUsd: usage.summary().estimated_cost_usd };
}
