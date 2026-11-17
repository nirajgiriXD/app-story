import type { JobMetadata } from "@app-story/contracts";
import type { LoadedProduct } from "@app-story/products";
import { AppStoryError, mapWithConcurrency } from "@app-story/shared";
import type { Job } from "../job-manager/job";
import { listPlans, planKey, readPlan } from "../pipeline/plans";
import type { ProviderOverrides } from "../pipeline/providers";
import type { Runtime } from "../runtime";
import { generateDemo } from "./generate";

export interface ReplayRequest {
  product: LoadedProduct;
  outputDir: string;
  /** Plans to replay, by name. Default: every saved plan of the product. */
  names?: string[];
  headless?: boolean;
  logLevel?: string;
  providers?: ProviderOverrides;
  runtime?: Runtime;
  onJobCreated?: (name: string, job: Job) => void;
}

/**
 * Make the videos of saved plans again, exactly as planned: the same clicks, and the
 * narration saved in each plan, so no AI is needed (in CI, for example). A plan that no
 * longer works fails its video instead of being planned again. A plan without saved
 * narration (an imported one) gets it written by the AI once, and saved in its file.
 */
export async function replayPlans(request: ReplayRequest): Promise<JobMetadata[]> {
  const { product } = request;
  const names = request.names?.length ? request.names.map(planKey) : (await listPlans(product)).map((p) => p.name);
  if (names.length === 0) {
    throw new AppStoryError("CONFIG_INVALID", `${product.id} has no saved plans to replay.`, {
      hint: `Make a video first (npx app-story ${product.id}), or import a Playwright trace: npx app-story import ${product.id} trace.zip`,
    });
  }
  // Every plan is read first, so a broken file stops the run before any video is made.
  const plans = await Promise.all(names.map(async (name) => ({ name, plan: await readPlan(product, name) })));
  // Two at a time, as `make` does: their heavy phases still take turns (see Runtime).
  return mapWithConcurrency(plans, 2, ({ name, plan }) =>
    generateDemo({
      product,
      outputDir: request.outputDir,
      objective: plan.objective,
      name,
      plan,
      replay: true,
      kind: plan.kind,
      headless: request.headless,
      logLevel: request.logLevel,
      providers: request.providers,
      runtime: request.runtime,
      onJobCreated: (job) => request.onJobCreated?.(name, job),
    }),
  );
}
