import OpenAI from "openai";
import type { AiProviderConfig } from "@app-story/contracts";
import { AppStoryError, type Logger } from "@app-story/shared";
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
import { mapOpenAIError } from "../openai/openai.provider";

/*
 * Any server that speaks the OpenAI Chat Completions API: Ollama, LM Studio, vLLM,
 * llama.cpp's server, or a hosted gateway such as OpenRouter. It lets AppStory run on
 * open-weight models with no paid key. Chat Completions (not the newer Responses API) is
 * used because it is the one these servers all offer.
 *
 *   APP_STORY_AI_BASE_URL=http://localhost:11434/v1   (Ollama; LM Studio: http://localhost:1234/v1)
 *   APP_STORY_AI_API_KEY=...                          (only if the server wants one)
 *   model: qwen3:32b                                  (in the product file: the server's model name)
 */

export interface LocalProviderDeps {
  usage: UsageTracker;
  log: Logger;
  /** Injected in tests. */
  client?: OpenAI;
}

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** The server's address, or an error that says how to set it. */
export function localBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.APP_STORY_AI_BASE_URL?.trim();
  if (!url) {
    throw new AppStoryError("CONFIG_INVALID", "APP_STORY_AI_BASE_URL is not set, so the local AI has no server to talk to.", {
      hint: "Add APP_STORY_AI_BASE_URL=http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio) to .env.",
    });
  }
  return url;
}

export class LocalProvider implements AIProvider {
  readonly name = "local" as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(
    private readonly config: AiProviderConfig,
    private readonly deps: LocalProviderDeps,
  ) {
    if (!config.model) {
      throw new AppStoryError("CONFIG_INVALID", "The local AI needs a model name.", {
        hint: "Set model: in the product file to a model your server has, e.g. model: qwen3:32b",
      });
    }
    this.model = config.model;
    this.client =
      deps.client ??
      new OpenAI({
        baseURL: localBaseUrl(),
        // Most local servers ignore the key, but the SDK wants one.
        apiKey: process.env.APP_STORY_AI_API_KEY?.trim() || "local",
        maxRetries: config.max_retries,
      });
  }

  /** Only what the user configured: local servers differ in what they accept. */
  private tuning(): { temperature?: number } {
    return this.config.temperature !== undefined ? { temperature: this.config.temperature } : {};
  }

  async generateText(request: TextGenerationRequest): Promise<string> {
    const completion = await this.call(() =>
      this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...this.tuning(),
      }),
    );
    this.track(completion.usage);
    return messageOf(completion).content?.trim() ?? "";
  }

  async generateStructuredOutput<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    const schema = toStrictJsonSchema(request.schema);
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      ...(request.images ?? []).map(
        (image): OpenAI.Chat.Completions.ChatCompletionContentPartImage => ({
          type: "image_url",
          image_url: { url: `data:${image.mediaType};base64,${image.data.toString("base64")}` },
        }),
      ),
      { type: "text", text: request.prompt },
    ];
    const completion = await this.call(() =>
      this.client.chat.completions.create({
        model: this.model,
        messages: [
          // The schema is in the prompt too: servers that ignore response_format still see it.
          { role: "system", content: `${request.system}\n\nAnswer with one JSON object that matches this JSON schema:\n${JSON.stringify(schema)}` },
          { role: "user", content },
        ],
        response_format: { type: "json_schema", json_schema: { name: request.schemaName, schema, strict: true } },
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...this.tuning(),
      }),
    );
    this.track(completion.usage);
    const text = messageOf(completion).content ?? "";
    const parsed = request.schema.safeParse(parseJson(text));
    if (!parsed.success) {
      throw new AppStoryError("PROVIDER_INVALID_OUTPUT", `The local model returned an invalid ${request.schemaName}: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  startAgentSession(request: AgentSessionRequest): AgentSession {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: toStrictJsonSchema(tool.inputSchema), strict: true },
    }));
    // The server keeps no state: the whole conversation is sent every turn.
    const messages: Message[] = [{ role: "system", content: request.system }];

    const send = async (input: AgentInput): Promise<AgentTurnResult> => {
      if (input.type === "user") {
        messages.push({ role: "user", content: input.text });
      } else {
        for (const r of input.results) messages.push({ role: "tool", tool_call_id: r.callId, content: r.isError ? `ERROR: ${r.content}` : r.content });
        if (input.note) messages.push({ role: "user", content: input.note });
      }
      const completion = await this.call(() =>
        this.client.chat.completions.create({
          model: this.model,
          messages,
          tools,
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          ...this.tuning(),
        }),
      );
      this.track(completion.usage);
      const message = messageOf(completion);
      messages.push({ role: "assistant", content: message.content ?? "", ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });
      const toolCalls = (message.tool_calls ?? []).flatMap((call) =>
        call.type === "function" ? [{ id: call.id, name: call.function.name, input: parseJson(call.function.arguments) }] : [],
      );
      const reason = completion.choices[0]?.finish_reason;
      const stop = message.refusal ? "refusal" : reason === "length" ? "max_tokens" : toolCalls.length > 0 ? "tool_calls" : "end";
      return { text: (message.content ?? "").trim(), toolCalls, stop, usage: usageOf(completion.usage) };
    };
    return { send };
  }

  private track(usage: OpenAI.Completions.CompletionUsage | undefined): void {
    this.deps.usage.record(this.name, this.model, usageOf(usage), this.config.pricing);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const mapped = mapOpenAIError(error, this.model);
      if (mapped instanceof AppStoryError && mapped.code === "PROVIDER_ERROR" && /reach/.test(mapped.message)) {
        throw new AppStoryError("PROVIDER_ERROR", "Could not reach the local AI server.", {
          cause: error,
          retryable: true,
          hint: "Is it running? Check APP_STORY_AI_BASE_URL.",
        });
      }
      throw mapped;
    }
  }
}

function messageOf(completion: OpenAI.Chat.Completions.ChatCompletion): OpenAI.Chat.Completions.ChatCompletionMessage {
  const message = completion.choices[0]?.message;
  if (!message) throw new AppStoryError("PROVIDER_INVALID_OUTPUT", "The local model returned no answer.");
  if (message.refusal) throw new AppStoryError("PROVIDER_REFUSAL", `The local model declined the request: ${message.refusal}`);
  return message;
}

/** JSON from a model's text, even when it wrapped it in a code fence or put thinking before it. */
function parseJson(text: string): unknown {
  const trimmed = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)?.[1] ?? trimmed;
  const start = fenced.search(/[{[]/);
  try {
    return JSON.parse(start > 0 ? fenced.slice(start) : fenced);
  } catch {
    return { __invalid_json: text };
  }
}

function usageOf(usage: OpenAI.Completions.CompletionUsage | undefined): TokenUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}
