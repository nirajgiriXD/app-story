import { copyFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AiProviderConfig } from "@app-story/contracts";
import { createAIProvider, UsageTracker, type AIProvider } from "@app-story/ai";
import type { LoadedProduct } from "@app-story/products";
import { AppStoryError, createLogger, ensureDir, fileExists, isAppStoryError } from "@app-story/shared";
import { makeBlogPost } from "../pipeline/blog";
import type { ProviderOverrides } from "../pipeline/providers";
import { endStages, enterStage } from "../pipeline/stages";
import { listTakes, loadTake, TAKES_PER_PRODUCT } from "../pipeline/takes";
import { storeFor, type Runtime } from "../runtime";

export interface BlogRequest {
  product: LoadedProduct;
  outputDir: string;
  /** The video to write about: its job id. Default: the product's newest video that kept its recording. */
  jobId?: string;
  logLevel?: string;
  providers?: ProviderOverrides;
  /** Default: the process's runtime. */
  runtime?: Runtime;
}

export interface BlogResult {
  jobId: string;
  /** The Markdown file, next to the video. */
  file: string;
  /** The screenshots it shows, next to it. */
  images: string[];
  /** The video is next to the post and embedded in it. */
  video: boolean;
  provider: string;
  model: string;
  costUsd: number | null;
}

/**
 * Write (or write again) the blog post of a video from its kept recording: the verified steps,
 * the voice-over and screenshots of the app. No browser, no app; one AI request. The post goes
 * next to the video in `output/`, replacing the one written with it.
 */
export async function writeBlog(request: BlogRequest): Promise<BlogResult> {
  const { product } = request;
  const store = storeFor(request.outputDir, request.runtime);
  const jobId = request.jobId ?? (await listTakes(store.dataDir, product.id))[0]?.jobId;
  if (!jobId) {
    throw new AppStoryError("CONFIG_INVALID", `No video of ${product.id} has a kept recording yet.`, {
      hint: `Make one first: app-story ${product.id} (the ${TAKES_PER_PRODUCT} newest videos of each product keep their recording)`,
    });
  }
  const take = await loadTake(store.dataDir, jobId);
  if (take.product_id !== product.id) {
    throw new AppStoryError("CONFIG_INVALID", `The video ${jobId} belongs to ${take.product_id}, not ${product.id}.`);
  }

  // Next to the video when it is still in output/, so the post can embed it.
  const delivered = store.getJob(jobId)?.video?.path;
  const video = Boolean(delivered && (await fileExists(delivered)));
  const dir = video ? dirname(delivered as string) : join(request.outputDir, product.id);
  const base = video ? basename(delivered as string, ".mp4") : `${jobId}-${take.name}`;
  const poster = await fileExists(join(dir, `${base}.png`));

  const log = createLogger({ level: request.logLevel });
  const usage = new UsageTracker();
  const workDir = join(store.dataDir, "work", `blog-${jobId}`);
  enterStage(log, "blog");
  try {
    let used: AIProvider | undefined;
    const files = await makeBlogPost({
      product,
      take,
      workDir,
      page: { base, video, poster },
      generate: (write) =>
        withFallback(product.config.providers.ai, product.config.providers.ai_fallback, log, (config) => {
          const deps = { usage, log };
          used = request.providers?.createAI ? request.providers.createAI(config, deps) : createAIProvider(config, deps);
          return write(used);
        }),
    });

    // The new post replaces the old one, with its screenshots.
    await ensureDir(dir);
    const stale = (await readdir(dir)).filter((name) => name.startsWith(`${base}.blog-`) && name.endsWith(".png"));
    for (const name of stale) await rm(join(dir, name), { force: true });
    const placed: string[] = [];
    for (const { file, suffix } of files) {
      const target = join(dir, `${base}${suffix}`);
      await rename(file, target).catch(() => copyFile(file, target));
      placed.push(target);
    }
    endStages(log, { ok: true });
    return {
      jobId,
      file: placed[0] as string,
      images: placed.slice(1),
      video,
      provider: used?.name ?? product.config.providers.ai.provider,
      model: used?.model ?? product.config.providers.ai.model ?? "(default)",
      costUsd: usage.summary().estimated_cost_usd,
    };
  } catch (error) {
    endStages(log, { ok: false, error: (error as Error).message.split("\n")[0] });
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** The configured provider; the fallback only when it fails as a provider (as for every AI step). */
async function withFallback<T>(
  main: AiProviderConfig,
  fallback: AiProviderConfig | undefined,
  log: ReturnType<typeof createLogger>,
  run: (config: AiProviderConfig) => Promise<T>,
): Promise<T> {
  try {
    return await run(main);
  } catch (error) {
    if (!fallback || !(isAppStoryError(error) && error.code.startsWith("PROVIDER_"))) throw error;
    log.warn({ to: fallback.provider, reason: (error as Error).message }, "writing the blog post failed; trying the fallback provider");
    return run(fallback);
  }
}
