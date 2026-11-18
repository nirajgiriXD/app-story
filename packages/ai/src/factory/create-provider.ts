import type { AiProviderConfig, AiProviderName } from "@app-story/contracts";
import { AppStoryError, aiKeySource, registerSecret, type Logger } from "@app-story/shared";
import type { AIProvider } from "../contracts/types";
import type { UsageTracker } from "../usage";
import { AnthropicProvider } from "../providers/anthropic/anthropic.provider";
import { OpenAIProvider } from "../providers/openai/openai.provider";
import { LocalProvider } from "../providers/local/local.provider";

export interface ProviderDeps {
  usage: UsageTracker;
  log: Logger;
}

export type AIProviderFactory = (config: AiProviderConfig, deps: ProviderDeps) => AIProvider;

/** The key each hosted provider needs. A local server needs none (APP_STORY_AI_API_KEY is optional). */
const API_KEY_ENV: Partial<Record<AiProviderName, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const factories = new Map<string, AIProviderFactory>([
  ["anthropic", (config, deps) => new AnthropicProvider(config, deps)],
  ["openai", (config, deps) => new OpenAIProvider(config, deps)],
  ["local", (config, deps) => new LocalProvider(config, deps)],
]);

/** Add another LLM provider without touching the orchestrator. */
export function registerAIProvider(name: string, factory: AIProviderFactory): void {
  factories.set(name, factory);
}

export function createAIProvider(config: AiProviderConfig, deps: ProviderDeps): AIProvider {
  const factory = factories.get(config.provider);
  if (!factory) {
    throw new AppStoryError("CONFIG_INVALID", `Unknown AI provider '${config.provider}'.`);
  }
  if (config.provider === "local") registerSecret(process.env.APP_STORY_AI_API_KEY);
  if (config.provider === "anthropic" || config.provider === "openai") {
    const envName = API_KEY_ENV[config.provider];
    const source = aiKeySource(config.provider);
    if (!source) {
      throw new AppStoryError("PROVIDER_AUTH", `${envName} is not set, so the ${config.provider} provider cannot start.`, {
        hint: `Add ${envName}=... (or CUSTOM_AI_API_KEY and CUSTOM_AI_BASE_URL) to .env, or pick another provider with --ai-provider.`,
      });
    }
    registerSecret(process.env[source]);
  }
  return factory(config, deps);
}
