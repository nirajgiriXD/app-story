import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { AiProviderConfig } from "@showrun/contracts";
import { ShowrunError, type Logger } from "@showrun/shared";
import type {
  AIProvider,
  AgentInput,
  AgentSession,
  AgentSessionRequest,
  AgentTurnResult,
  StructuredGenerationRequest,
  TextGenerationRequest,
  TokenUsage,
} from "../../contracts/types";
import { toStrictJsonSchema } from "../../contracts/json-schema";
import type { UsageTracker } from "../../usage";
import { OPENAI_DEFAULT_MODEL, OPENAI_MAX_OUTPUT_TOKENS, openAiReasoningEffort } from "./openai.models";

export interface OpenAIProviderDeps {
  usage: UsageTracker;
  log: Logger;
  /** Injected in tests. */
  client?: OpenAI;
}

type ResponseInput = OpenAI.Responses.ResponseInputItem[];

/** OpenAI implementation on the Responses API. */
export class OpenAIProvider implements AIProvider {
  readonly name = "openai" as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(
    private readonly config: AiProviderConfig,
    private readonly deps: OpenAIProviderDeps,
  ) {
    this.model = config.model ?? OPENAI_DEFAULT_MODEL;
    this.client = deps.client ?? new OpenAI({ maxRetries: config.max_retries });
  }

  /** Only send tuning parameters the user configured; reasoning models reject temperature. */
  private tuning(): Pick<OpenAI.Responses.ResponseCreateParamsNonStreaming, "reasoning" | "temperature"> {
    const effort = openAiReasoningEffort(this.config.effort);
    return {
      ...(effort ? { reasoning: { effort } } : {}),
      ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
    };
  }

  async generateText(request: TextGenerationRequest): Promise<string> {
    const response = await this.call(() =>
      this.client.responses.create({
        model: this.model,
        instructions: request.system,
        input: request.prompt,
        max_output_tokens: request.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS.text,
        ...this.tuning(),
      }),
    );
    this.track(response.usage);
    assertComplete(response);
    return response.output_text.trim();
  }

  async generateStructuredOutput<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    const response = await this.call(() =>
      this.client.responses.parse({
        model: this.model,
        instructions: request.system,
        input: request.prompt,
        max_output_tokens: request.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS.structured,
        text: { format: zodTextFormat(request.schema, request.schemaName) },
        ...this.tuning(),
      }),
    );
    this.track(response.usage);
    assertComplete(response);
    const parsed = request.schema.safeParse(response.output_parsed);
    if (!parsed.success) {
      throw new ShowrunError("PROVIDER_INVALID_OUTPUT", `OpenAI returned an invalid ${request.schemaName}: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  startAgentSession(request: AgentSessionRequest): AgentSession {
    const tools: OpenAI.Responses.FunctionTool[] = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: toStrictJsonSchema(tool.inputSchema),
      strict: true,
    }));
    let previousResponseId: string | undefined;

    const send = async (input: AgentInput): Promise<AgentTurnResult> => {
      const items: ResponseInput =
        input.type === "user"
          ? [{ role: "user", content: input.text }]
          : [
              ...input.results.map(
                (r): OpenAI.Responses.ResponseInputItem.FunctionCallOutput => ({
                  type: "function_call_output",
                  call_id: r.callId,
                  output: r.isError ? `ERROR: ${r.content}` : r.content,
                }),
              ),
              ...(input.note ? [{ role: "user" as const, content: input.note }] : []),
            ];

      const response = await this.call(() =>
        this.client.responses.create({
          model: this.model,
          instructions: request.system,
          input: items,
          tools,
          parallel_tool_calls: false,
          previous_response_id: previousResponseId,
          max_output_tokens: request.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS.agentTurn,
          ...this.tuning(),
        }),
      );
      previousResponseId = response.id;
      this.track(response.usage);

      const toolCalls = response.output
        .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call")
        .map((call) => ({ id: call.call_id, name: call.name, input: safeJson(call.arguments) }));
      const refused = response.output.some(
        (item) => item.type === "message" && item.content.some((c) => c.type === "refusal"),
      );
      const truncated = response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens";
      const stop = refused ? "refusal" : truncated ? "max_tokens" : toolCalls.length > 0 ? "tool_calls" : "end";
      return { text: response.output_text.trim(), toolCalls, stop, usage: usageOf(response.usage) };
    };
    return { send };
  }

  private track(usage: OpenAI.Responses.ResponseUsage | undefined): void {
    this.deps.usage.record(this.name, this.model, usageOf(usage), this.config.pricing);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw mapOpenAIError(error, this.model);
    }
  }
}

function usageOf(usage: OpenAI.Responses.ResponseUsage | undefined): TokenUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { __invalid_json: text };
  }
}

function assertComplete(response: OpenAI.Responses.Response): void {
  const refusal = response.output
    .flatMap((item) => (item.type === "message" ? item.content : []))
    .find((c) => c.type === "refusal");
  if (refusal && refusal.type === "refusal") {
    throw new ShowrunError("PROVIDER_REFUSAL", `OpenAI declined the request: ${refusal.refusal}`);
  }
  if (response.status === "incomplete") {
    throw new ShowrunError(
      "PROVIDER_INVALID_OUTPUT",
      `OpenAI response was incomplete (${response.incomplete_details?.reason ?? "unknown reason"}).`,
    );
  }
}

export function mapOpenAIError(error: unknown, model: string): unknown {
  if (error instanceof ShowrunError) return error;
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new ShowrunError("PROVIDER_AUTH", "OpenAI rejected the API key.", {
      cause: error,
      hint: "Check OPENAI_API_KEY in your .env file.",
    });
  }
  if (error instanceof OpenAI.NotFoundError) {
    return new ShowrunError("PROVIDER_ERROR", `OpenAI model '${model}' was not found.`, {
      cause: error,
      hint: "Set a valid model id in providers.ai.model.",
    });
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new ShowrunError("PROVIDER_RATE_LIMIT", "OpenAI rate limit reached (after retries).", { cause: error, retryable: true });
  }
  if (error instanceof OpenAI.BadRequestError) {
    return new ShowrunError("PROVIDER_ERROR", `OpenAI rejected the request: ${error.message}`, { cause: error });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ShowrunError("PROVIDER_ERROR", "Could not reach the OpenAI API.", { cause: error, retryable: true });
  }
  if (error instanceof OpenAI.APIError) {
    return new ShowrunError("PROVIDER_ERROR", `OpenAI API error ${error.status ?? ""}: ${error.message}`, {
      cause: error,
      retryable: (error.status ?? 0) >= 500,
    });
  }
  return error;
}
