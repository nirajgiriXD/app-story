import type { Command } from "commander";
import type { VideoKind } from "@showrun/contracts";
import { generateDemo, planFeatures } from "@showrun/core";
import { objectiveForAllFeatures, objectiveForFeature, type LoadedProduct } from "@showrun/products";
import { ShowrunError, slugify } from "@showrun/shared";
import { globals, openProduct } from "../context";
import { bold, dim, exitCodeFor, green, printJob } from "../output";

export interface MakeOptions {
  each?: boolean;
  fresh?: boolean;
  headed?: boolean;
}

/**
 * `showrun <product> [goal...]`: with a goal, one video of it; without, the AI picks the
 * new features from the product file's release notes and makes one video (or one each).
 */
export async function makeVideos(productId: string | undefined, goalWords: string[], opts: MakeOptions, cmd: Command): Promise<void> {
  if (!productId) {
    cmd.help();
    return;
  }
  const goal = goalWords.join(" ").trim();
  if (goal && opts.each) {
    throw new ShowrunError("CONFIG_INVALID", "--each splits the release notes into one video per feature, so it cannot be used with a goal.");
  }
  const { outputDir, logLevel } = globals(cmd);
  const product = await openProduct(productId);
  const jobs = goal ? [{ objective: goal, name: slugify(goal), kind: "how-to" as const }] : await featureJobs(product, Boolean(opts.each), logLevel);

  const results = [];
  for (const job of jobs) {
    results.push(
      await generateDemo({
        product,
        outputDir,
        logLevel,
        ...job,
        fresh: opts.fresh,
        headless: opts.headed ? false : undefined,
        onJobCreated: (j) => console.log(dim(`Making "${job.name}" → ${j.paths.root}`)),
      }),
    );
  }
  results.forEach(printJob);
  process.exitCode = results.every((m) => exitCodeFor(m) === 0) ? 0 : 1;
}

/** Let the AI pick the new features from the release notes, then one job for all, or one each. */
async function featureJobs(
  product: LoadedProduct,
  each: boolean,
  logLevel: string | undefined,
): Promise<{ objective: string; name: string; kind: VideoKind }[]> {
  const { plan, costUsd } = await planFeatures({ product, logLevel });
  const cost = costUsd ? ` · $${costUsd.toFixed(3)}` : "";
  console.log(`${bold(`New in ${plan.title ?? product.config.product.name}`)} ${dim(`(from ${product.file}${cost})`)}`);
  for (const f of plan.features) console.log(`  ${green("•")} ${f.title}`);
  for (const s of plan.skipped) console.log(dim(`  - skipped: ${s.item} (${s.reason})`));
  console.log();

  if (each) return plan.features.map((f) => ({ objective: objectiveForFeature(f), name: slugify(f.title), kind: "feature" as const }));
  const first = plan.features[0] as { title: string };
  const name = plan.title ? `whats-new-${plan.title}` : plan.features.length === 1 ? first.title : "whats-new";
  return [{ objective: objectiveForAllFeatures(plan), name: slugify(name), kind: "whats-new" }];
}
