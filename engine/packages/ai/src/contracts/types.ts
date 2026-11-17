import type { z } from "zod";
import type { AiProviderConfig, AiProviderName } from "@app-story/contracts";

/** Reasoning depth for one request. An `effort` set in the provider config always wins. */
export type Effort = NonNullable<AiProviderConfig["effort"]>;

/**
 * Default effort per phase. Driving a browser and picking features get full reasoning;
 * writing a short script needs little. `APP_STORY_AI_EFFORT` overrides every phase.
 */
export const PHASE_EFFORT = {
  rehearsal: "high",
  features: "high",
  narration: "low",
  review: "medium",
} as const satisfies Record<string, Effort>;

/**
 * Provider-neutral contracts. Nothing in here references an SDK type, so the agents,
 * the workflow engine and the orchestrator never see Anthropic or OpenAI formats.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** Zod object schema. Optional fields must be `.nullable()` so strict mode works on both providers. */
  inputSchema: z.ZodType;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

export type AgentInput = { type: "user"; text: string } | { type: "tool_results"; results: ToolResult[]; note?: string };

export type AgentStopReason = "tool_calls" | "end" | "max_tokens" | "refusal";

export interface AgentTurnResult {
  text: string;
  toolCalls: ToolCall[];
  stop: AgentStopReason;
  usage: TokenUsage;
}

/** A multi-turn tool-using conversation. Each provider keeps its own native history inside. */
export interface AgentSession {
  send(input: AgentInput): Promise<AgentTurnResult>;
}

export interface TextGenerationRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  effort?: Effort;
}

export interface StructuredGenerationRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Short identifier for the schema, e.g. `narration_script`. */
  schemaName: string;
  maxTokens?: number;
  effort?: Effort;
  /** Pictures the model looks at, before the prompt (for example frames of a video). */
  images?: ImageInput[];
}

export interface ImageInput {
  mediaType: "image/jpeg" | "image/png";
  data: Buffer;
}

export interface AgentSessionRequest {
  system: string;
  tools: ToolSpec[];
  maxTokens?: number;
  effort?: Effort;
}

export interface AIProvider {
  readonly name: AiProviderName;
  readonly model: string;
  generateText(request: TextGenerationRequest): Promise<string>;
  generateStructuredOutput<T>(request: StructuredGenerationRequest<T>): Promise<T>;
  startAgentSession(request: AgentSessionRequest): AgentSession;
}
