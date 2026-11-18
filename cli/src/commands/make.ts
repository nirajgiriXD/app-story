import type { Command } from "commander";
import type { VideoKind } from "@app-story/contracts";
import { generateDemo, isNothingNew, planFeatures } from "@app-story/core";
import { objectiveForAllFeatures, objectiveForFeature, type LoadedProduct } from "@app-story/products";
import { AppStoryError, mapWithConcurrency, slugify } from "@app-story/shared";
import { globals, openProduct } from "../context";
import { bold, dim, exitCodeFor, green, printJob } from "../output";
import { terminalReviewer } from "../review";

export interface MakeOptions {
  each?: boolean;
  videos?: boolean;
  review?: boolean;
  fresh?: boolean;
  headed?: boolean;
}

/**
 * `app-story <product> [goal...]`: with a goal, one video of it; with `--videos`, one video
 * per goal under the product file's `## Videos`; otherwise the AI picks the new features
 * from the release notes and makes one video (or one each).
 */
export async function makeVideos(productId: string | undefined, goalWords: string[], opts: MakeOptions, cmd: Command): Promise<void> {
  if (!productId) {
    cmd.help();
    return;
  }
  const goal = goalWords.join(" ").trim();
  if (goal && opts.each) {
    throw new AppStoryError("CONFIG_INVALID", "--each splits the release notes into one video per feature, so it cannot be used with a goal.");
  }
  if (opts.videos && (goal || opts.each)) {
    throw new AppStoryError("CONFIG_INVALID", `--videos makes the videos listed in the product file, so it cannot be used with ${goal ? "a goal" : "--each"}.`);
  }
  // Before any AI work: --review needs a terminal to ask in.
  const approve = opts.review ? terminalReviewer() : undefined;
  const { outputDir, logLevel } = globals(cmd);
  const product = await openProduct(productId);
  const jobs = goal
    ? [howTo(goal)]
    : opts.videos
      ? listedVideos(product)
      : await featureJobs(product, Boolean(opts.each), { logLevel, outputDir, fresh: opts.fresh }).catch((error: unknown) => {
          // Nothing new in the release notes, but the file lists videos: make those instead.
          if (!isNothingNew(error) || !product.videos?.length) throw error;
          console.log(dim(`Nothing new in the release notes, so making the videos listed under "## Videos".`));
          return listedVideos(product);
        });

  // Two videos at a time: the next one is planned by the AI while the current one records
  // and renders (those heavy phases still take turns, see `exclusive` in core).
  const results = await mapWithConcurrency(jobs, 2, (job) =>
    generateDemo({
      product,
      outputDir,
      logLevel,
      ...job,
      fresh: opts.fresh,
      approve,
      headless: opts.headed ? false : undefined,
      onJobCreated: (j) => console.log(dim(`Making "${job.name}" → ${j.paths.root}`)),
    }),
  );
  results.forEach(printJob);
  process.exitCode = results.every((m) => exitCodeFor(m) === 0) ? 0 : 1;
}

/** A video of a goal in plain words: the same one, and the same saved plan, from the command line or `## Videos`. */
function howTo(goal: string): { objective: string; name: string; kind: VideoKind } {
  return { objective: goal, name: slugify(goal), kind: "how-to" };
}

/** One how-to video per goal under `## Videos` in the product file. */
function listedVideos(product: LoadedProduct): { objective: string; name: string; kind: VideoKind }[] {
  const videos = product.videos ?? [];
  if (!videos.length) {
    throw new AppStoryError("CONFIG_INVALID", `${product.file} has no videos listed.`, {
      hint: "Add a section with one goal per line, e.g.\n## Videos\n- Search for pliers and add one to the cart",
    });
  }
  const names = new Set<string>();
  for (const video of videos) {
    const name = slugify(video);
    if (names.has(name)) throw new AppStoryError("CONFIG_INVALID", `"${video}" is listed twice under ## Videos in ${product.file}.`);
    names.add(name);
  }
  console.log(`${bold(`Videos in ${product.config.product.name}`)} ${dim(`(from ${product.file})`)}`);
  for (const video of videos) console.log(`  ${green("•")} ${video}`);
  console.log();
  return videos.map(howTo);
}

/** Let the AI pick the new features from the release notes, then one job for all, or one each. */
async function featureJobs(
  product: LoadedProduct,
  each: boolean,
  options: { logLevel: string | undefined; outputDir: string; fresh?: boolean },
): Promise<{ objective: string; name: string; kind: VideoKind }[]> {
  const { plan, costUsd, cached } = await planFeatures({ product, ...options });
  const cost = cached ? " · from last run" : costUsd ? ` · $${costUsd.toFixed(3)}` : "";
  console.log(`${bold(`New in ${plan.title ?? product.config.product.name}`)} ${dim(`(from ${product.file}${cost})`)}`);
  for (const f of plan.features) console.log(`  ${green("•")} ${f.title}`);
  for (const s of plan.skipped) console.log(dim(`  - skipped: ${s.item} (${s.reason})`));
  console.log();

  if (each) return plan.features.map((f) => ({ objective: objectiveForFeature(f), name: slugify(f.title), kind: "feature" as const }));
  const first = plan.features[0] as { title: string };
  const name = plan.title ? `whats-new-${plan.title}` : plan.features.length === 1 ? first.title : "whats-new";
  return [{ objective: objectiveForAllFeatures(plan), name: slugify(name), kind: "whats-new" }];
}
