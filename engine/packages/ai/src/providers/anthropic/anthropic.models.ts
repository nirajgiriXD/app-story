/** Default when the product file sets no `model:`. Any valid Claude model id can be configured. */
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/** Effort is the depth control on current Claude models (thinking is adaptive and always on). */
export const ANTHROPIC_DEFAULT_EFFORT = "high" as const;

export const ANTHROPIC_MAX_TOKENS = {
  text: 16_000,
  structured: 16_000,
  agentTurn: 32_000,
} as const;
