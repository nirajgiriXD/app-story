/**
 * A custom gateway (e.g. a LiteLLM proxy): one key that reaches Claude and OpenAI models
 * through CUSTOM_AI_BASE_URL, which serves Anthropic's /v1/messages and OpenAI's /v1 API.
 * It is used only when both variables are set, and a provider's own key wins over it.
 */
export const CUSTOM_KEY_ENV = "CUSTOM_AI_API_KEY";
export const CUSTOM_URL_ENV = "CUSTOM_AI_BASE_URL";

export type KeyedAiService = "anthropic" | "openai";

export interface CustomGateway {
  key: string;
  /** Without a trailing slash or /v1. */
  baseURL: string;
}

export function customGateway(env: NodeJS.ProcessEnv = process.env): CustomGateway | undefined {
  const key = env[CUSTOM_KEY_ENV]?.trim();
  const url = env[CUSTOM_URL_ENV]?.trim();
  if (!key || !url) return undefined;
  return { key, baseURL: url.replace(/\/+$/, "").replace(/\/v1$/, "") };
}

/** The variable a service's credentials come from: its own key first, then the gateway's. */
export function aiKeySource(service: KeyedAiService, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const own = service === "anthropic" ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] : ["OPENAI_API_KEY"];
  const found = own.find((name) => env[name]);
  if (found) return found;
  return customGateway(env) ? CUSTOM_KEY_ENV : undefined;
}

/** The gateway to send this service's calls through, or undefined when its own key is set. */
export function gatewayFor(service: KeyedAiService, env: NodeJS.ProcessEnv = process.env): CustomGateway | undefined {
  return aiKeySource(service, env) === CUSTOM_KEY_ENV ? customGateway(env) : undefined;
}

/** Extra Anthropic SDK options: the gateway's URL, its key as a Bearer token. */
export function anthropicGatewayOptions(env: NodeJS.ProcessEnv = process.env): { apiKey?: null; authToken?: string; baseURL?: string } {
  const gateway = gatewayFor("anthropic", env);
  return gateway ? { apiKey: null, authToken: gateway.key, baseURL: gateway.baseURL } : {};
}

/** Extra OpenAI SDK options: the gateway's OpenAI-compatible /v1 and its key. */
export function openaiGatewayOptions(env: NodeJS.ProcessEnv = process.env): { apiKey?: string; baseURL?: string } {
  const gateway = gatewayFor("openai", env);
  return gateway ? { apiKey: gateway.key, baseURL: `${gateway.baseURL}/v1` } : {};
}
