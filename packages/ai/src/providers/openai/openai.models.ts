import type { AiProviderConfig } from "@app-story/contracts";

/** Default when the product file sets no `model:`. Any valid OpenAI model id can be configured. */
export const OPENAI_DEFAULT_MODEL = "gpt-5";

export const OPENAI_MAX_OUTPUT_TOKENS = {
  text: 16_000,
  structured: 16_000,
  agentTurn: 32_000,
} as const;

/** OpenAI reasoning effort has fewer levels; map the shared scale onto it. */
export function openAiReasoningEffort(effort: AiProviderConfig["effort"]): "low" | "medium" | "high" | undefined {
  switch (effort) {
    case undefined:
      return undefined;
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}
