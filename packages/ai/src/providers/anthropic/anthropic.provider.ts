import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AiProviderConfig } from "@app-story/contracts";
import { AppStoryError, CUSTOM_KEY_ENV, aiKeySource, anthropicGatewayOptions, type Logger } from "@app-story/shared";
import type {
  AIProvider,
  AgentInput,
  AgentSession,
  AgentSessionRequest,
  AgentTurnResult,
  StructuredGenerationRequest,
  TextGenerationRequest,
  TokenUsage,
  Effort,
} from "../../contracts/types";
import { toStrictJsonSchema } from "../../contracts/json-schema";
import type { UsageTracker } from "../../usage";
import { ANTHROPIC_DEFAULT_EFFORT, ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_MAX_TOKENS } from "./anthropic.models";

export interface AnthropicProviderDeps {
  usage: UsageTracker;
  log: Logger;
  /** Injected in tests. */
  client?: Anthropic;
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(
    private readonly config: AiProviderConfig,
    private readonly deps: AnthropicProviderDeps,
  ) {
    this.model = config.model ?? ANTHROPIC_DEFAULT_MODEL;
    // Credentials come from ANTHROPIC_API_KEY (or an `ant auth login` profile), else the
    // custom gateway's (CUSTOM_AI_API_KEY). The SDK retries 408/409/429/5xx and connection errors with backoff.
    this.client = deps.client ?? new Anthropic({ maxRetries: config.max_retries, ...anthropicGatewayOptions() });
    if (config.temperature !== undefined) {
      deps.log.warn("providers.ai.temperature is ignored for Claude: current models only accept effort.");
    }
  }

  async generateText(request: TextGenerationRequest): Promise<string> {
    const message = await this.call(() =>
      this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? ANTHROPIC_MAX_TOKENS.text,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        output_config: { effort: this.effortFor(request.effort) },
      }),
    );
    this.track(message.usage);
    assertNotRefused(message);
    return textOf(message.content);
  }

  async generateStructuredOutput<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    const message = await this.call(() =>
      this.client.messages.parse({
        model: this.model,
        max_tokens: request.maxTokens ?? ANTHROPIC_MAX_TOKENS.structured,
        system: request.system,
        messages: [
          {
            role: "user",
            content: [
              ...(request.images ?? []).map(
                (image): Anthropic.ImageBlockParam => ({
                  type: "image",
                  source: { type: "base64", media_type: image.mediaType, data: image.data.toString("base64") },
                }),
              ),
              { type: "text", text: request.prompt },
            ],
          },
        ],
        output_config: { effort: this.effortFor(request.effort), format: zodOutputFormat(request.schema) },
      }),
    );
    this.track(message.usage);
    assertNotRefused(message);
    if (message.stop_reason === "max_tokens") {
      throw new AppStoryError("PROVIDER_INVALID_OUTPUT", `${request.schemaName} was cut off at max_tokens.`);
    }
    const parsed = request.schema.safeParse(message.parsed_output);
    if (!parsed.success) {
      throw new AppStoryError("PROVIDER_INVALID_OUTPUT", `Claude returned an invalid ${request.schemaName}: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  startAgentSession(request: AgentSessionRequest): AgentSession {
    const tools: Anthropic.Tool[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: toStrictJsonSchema(tool.inputSchema) as Anthropic.Tool.InputSchema,
      strict: true,
      eager_input_streaming: true,
    }));
    const messages: Anthropic.MessageParam[] = [];
    const maxTokens = request.maxTokens ?? ANTHROPIC_MAX_TOKENS.agentTurn;
    // One effort for the whole session: changing it between turns would reset the prompt cache.
    const effort = this.effortFor(request.effort);

    const send = async (input: AgentInput): Promise<AgentTurnResult> => {
      if (input.type === "user") {
        messages.push({ role: "user", content: input.text });
      } else {
        // All tool results for one turn go back in a single user message.
        const content: Anthropic.ContentBlockParam[] = input.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.callId,
          content: r.content,
          is_error: r.isError ?? false,
        }));
        if (input.note) content.push({ type: "text", text: input.note });
        messages.push({ role: "user", content });
      }

      let message: Anthropic.Message | undefined;
      for (let jsonRetries = 0; !message; jsonRetries++) {
        try {
          message = await this.call(() =>
            this.client.messages
              .stream({
                model: this.model,
                max_tokens: maxTokens,
                system: request.system,
                tools,
                messages,
                output_config: { effort },
                // Cache the growing conversation prefix between turns of the agent loop.
                cache_control: { type: "ephemeral" },
              })
              .finalMessage(),
          );
        } catch (error) {
          // With eager input streaming, an unparseable tool input surfaces as a non-API error.
          if (error instanceof AppStoryError || jsonRetries >= 2) throw error;
          this.deps.log.warn("tool input was not valid JSON; re-issuing the turn");
        }
      }
      this.track(message.usage);
      // Keep the full content (including thinking blocks) so the next turn is valid.
      messages.push({ role: "assistant", content: message.content });

      const toolCalls = message.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const stop =
        message.stop_reason === "refusal" ? "refusal" : message.stop_reason === "max_tokens" ? "max_tokens" : toolCalls.length > 0 ? "tool_calls" : "end";
      return { text: textOf(message.content), toolCalls, stop, usage: usageOf(message.usage) };
    };
    return { send };
  }

  /** The product's configured effort wins; otherwise the phase's own default. */
  private effortFor(requested: Effort | undefined): Effort {
    return this.config.effort ?? requested ?? ANTHROPIC_DEFAULT_EFFORT;
  }

  private track(usage: Anthropic.Usage): void {
    this.deps.usage.record(this.name, this.model, usageOf(usage), this.config.pricing);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw mapAnthropicError(error, this.model);
    }
  }
}

function usageOf(usage: Anthropic.Usage): TokenUsage {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens + cacheRead + cacheWrite,
    outputTokens: usage.output_tokens,
    cachedInputTokens: cacheRead,
  };
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function assertNotRefused(message: Anthropic.Message): void {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ?? "unspecified";
    throw new AppStoryError("PROVIDER_REFUSAL", `Claude declined the request (category: ${category}).`);
  }
}

export function mapAnthropicError(error: unknown, model: string): unknown {
  if (error instanceof AppStoryError) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    const viaGateway = aiKeySource("anthropic") === CUSTOM_KEY_ENV;
    return new AppStoryError(
      "PROVIDER_AUTH",
      viaGateway ? `The custom AI gateway refused model '${model}': ${error.message}` : "Anthropic rejected the API key.",
      {
        cause: error,
        hint: viaGateway
          ? `Check CUSTOM_AI_API_KEY, and that the gateway gives this key the model (\`app-story check\` lists the ones it has).`
          : "Check ANTHROPIC_API_KEY in your .env file.",
      },
    );
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new AppStoryError("PROVIDER_ERROR", `Claude model '${model}' was not found.`, {
      cause: error,
      hint: "Set a valid model id in providers.ai.model, e.g. claude-opus-5-5.",
    });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AppStoryError("PROVIDER_RATE_LIMIT", "Anthropic rate limit reached (after retries).", { cause: error, retryable: true });
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new AppStoryError("PROVIDER_ERROR", `Anthropic rejected the request: ${error.message}`, { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AppStoryError("PROVIDER_ERROR", "Could not reach the Anthropic API.", { cause: error, retryable: true });
  }
  if (error instanceof Anthropic.APIError) {
    return new AppStoryError("PROVIDER_ERROR", `Anthropic API error ${error.status ?? ""}: ${error.message}`, {
      cause: error,
      retryable: (error.status ?? 0) >= 500,
    });
  }
  return error;
}
