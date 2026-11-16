import type { AiProviderConfig, ProductConfig } from "@app-story/contracts";
import { createAIProvider, type AIProvider, type AIProviderFactory } from "@app-story/ai";
import { createTTSProvider, type TTSProvider } from "@app-story/narration";
import { isAppStoryError } from "@app-story/shared";
import { saveMetadata, type Job } from "../job-manager/job";

/** Dependency-injection points at the provider boundaries (used by tests and extensions). */
export interface ProviderOverrides {
  createAI?: AIProviderFactory;
  createTTS?: (config: ProductConfig["providers"]["tts"]) => TTSProvider;
}

export function makeAI(job: Job, config: AiProviderConfig, overrides: ProviderOverrides): AIProvider {
  const deps = { usage: job.usage, log: job.log };
  return overrides.createAI ? overrides.createAI(config, deps) : createAIProvider(config, deps);
}

export function makeTTS(config: ProductConfig["providers"]["tts"], overrides: ProviderOverrides): TTSProvider {
  return overrides.createTTS ? overrides.createTTS(config) : createTTSProvider(config);
}

function isProviderFailure(error: unknown): boolean {
  return isAppStoryError(error) && error.code.startsWith("PROVIDER_");
}

/**
 * Run an AI phase with the configured provider. Only when it fails *as a provider*
 * (auth, rate limit, outage, refusal, invalid output) and a fallback is explicitly
 * configured is the fallback tried. Every attempt and switch is written to metadata.
 */
export async function withProviderFallback<T>(
  job: Job,
  phase: string,
  config: ProductConfig,
  overrides: ProviderOverrides,
  run: (provider: AIProvider) => Promise<T>,
): Promise<T> {
  const attempt = async (cfg: AiProviderConfig, fallback: boolean): Promise<T> => {
    let provider: AIProvider | undefined;
    try {
      provider = makeAI(job, cfg, overrides);
      if (!fallback && !job.metadata.ai.provider) {
        job.metadata.ai.provider = provider.name;
        job.metadata.ai.model = provider.model;
      }
      const result = await run(provider);
      job.metadata.ai.attempts.push({ phase, provider: provider.name, model: provider.model, outcome: "success", fallback, at: new Date().toISOString() });
      return result;
    } catch (error) {
      job.metadata.ai.attempts.push({
        phase,
        provider: provider?.name ?? cfg.provider,
        model: provider?.model ?? cfg.model ?? "(default)",
        outcome: "failed",
        error: (error as Error).message,
        fallback,
        at: new Date().toISOString(),
      });
      await saveMetadata(job);
      throw error;
    }
  };

  const fallbackConfig = config.providers.ai_fallback;
  job.metadata.ai.fallback_configured = Boolean(fallbackConfig);
  try {
    return await attempt(config.providers.ai, false);
  } catch (error) {
    if (!fallbackConfig || !isProviderFailure(error)) throw error;
    job.log.warn(
      { from: config.providers.ai.provider, to: fallbackConfig.provider, reason: (error as Error).message },
      `AI provider failed during ${phase}; switching to the configured fallback`,
    );
    job.metadata.ai.fallback_used = true;
    job.metadata.warnings.push(
      `${phase}: switched from ${config.providers.ai.provider} to fallback ${fallbackConfig.provider} after: ${(error as Error).message}`,
    );
    return attempt(fallbackConfig, true);
  }
}
