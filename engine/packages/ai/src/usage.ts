import type { AiProviderConfig, UsageSummary } from "@showrun/contracts";
import type { TokenUsage } from "./contracts/types";

interface Price {
  input: number;
  output: number;
  cachedInput: number;
}

/**
 * List prices in USD per million tokens, used only for the cost *estimate* in job
 * metadata. Override per product with `providers.ai.pricing` when your rates differ.
 */
const DEFAULT_PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cachedInput: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cachedInput: 0.01 },
  "gpt-5": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025 },
};

interface Bucket extends TokenUsage {
  provider: string;
  model: string;
  requests: number;
  price: Price | undefined;
}

export class UsageTracker {
  private buckets = new Map<string, Bucket>();

  record(provider: string, model: string, usage: TokenUsage, pricing?: AiProviderConfig["pricing"]): void {
    const key = `${provider}/${model}`;
    const bucket =
      this.buckets.get(key) ??
      ({
        provider,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        requests: 0,
        price: pricing
          ? { input: pricing.input_per_mtok, output: pricing.output_per_mtok, cachedInput: pricing.cached_input_per_mtok ?? pricing.input_per_mtok }
          : DEFAULT_PRICES[model],
      } satisfies Bucket);
    bucket.inputTokens += usage.inputTokens;
    bucket.outputTokens += usage.outputTokens;
    bucket.cachedInputTokens += usage.cachedInputTokens;
    bucket.requests += 1;
    this.buckets.set(key, bucket);
  }

  summary(): UsageSummary {
    const byModel = [...this.buckets.values()].map((b) => ({
      provider: b.provider,
      model: b.model,
      input_tokens: b.inputTokens,
      output_tokens: b.outputTokens,
      cached_input_tokens: b.cachedInputTokens,
      requests: b.requests,
      estimated_cost_usd: b.price ? round(cost(b, b.price)) : null,
    }));
    const unknownPrice = byModel.some((m) => m.estimated_cost_usd === null);
    return {
      input_tokens: sum(byModel.map((m) => m.input_tokens)),
      output_tokens: sum(byModel.map((m) => m.output_tokens)),
      cached_input_tokens: sum(byModel.map((m) => m.cached_input_tokens)),
      requests: sum(byModel.map((m) => m.requests)),
      estimated_cost_usd: unknownPrice ? null : round(sum(byModel.map((m) => m.estimated_cost_usd ?? 0))),
      by_model: byModel,
    };
  }
}

function cost(b: TokenUsage, p: Price): number {
  const uncached = Math.max(0, b.inputTokens - b.cachedInputTokens);
  return (uncached * p.input + b.cachedInputTokens * p.cachedInput + b.outputTokens * p.output) / 1_000_000;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round = (n: number) => Math.round(n * 10_000) / 10_000;
