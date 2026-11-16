import type { TtsConfig } from "@app-story/contracts";
import type { TTSProvider } from "@app-story/narration";
import { runFfmpeg } from "@app-story/shared";
import type {
  AIProvider,
  AgentInput,
  AgentSession,
  AgentTurnResult,
  StructuredGenerationRequest,
  ToolCall,
  UsageTracker,
} from "@app-story/ai";

/** Test-only TTS: a soft tone whose length matches natural speech for the text. */
export class ToneTTS implements TTSProvider {
  readonly name = "tone";
  readonly voice = "tone";
  readonly model = "ffmpeg-sine";
  readonly calls: string[] = [];

  constructor(_config?: TtsConfig) {}

  async synthesize(text: string, outPath: string): Promise<void> {
    this.calls.push(text);
    const seconds = Math.max(0.8, text.split(/\s+/).length / 2.6);
    await runFfmpeg(["-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds.toFixed(2)}`, "-af", "volume=0.3", "-ac", "2", "-ar", "44100", outPath]);
  }
}

/**
 * Test-only AI provider that plays a fixed script of tool calls, one per turn,
 * and returns canned structured output. Lets the agent loop run deterministically.
 */
export class ScriptedProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "scripted-model";
  readonly received: AgentInput[] = [];
  /** Set by the factory in tests so usage is tracked like a real provider. */
  usage?: UsageTracker;

  constructor(
    private readonly script: Omit<ToolCall, "id">[],
    private readonly structured: Record<string, unknown> = {},
  ) {}

  async generateText(): Promise<string> {
    return "ok";
  }

  /** Prompts sent to generateStructuredOutput, in order. */
  readonly structuredPrompts: string[] = [];

  async generateStructuredOutput<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    this.structuredPrompts.push(request.prompt);
    const value = this.structured[request.schemaName];
    if (value === undefined) throw new Error(`no canned output for ${request.schemaName}`);
    return request.schema.parse(value);
  }

  startAgentSession(): AgentSession {
    let index = 0;
    return {
      send: async (input: AgentInput): Promise<AgentTurnResult> => {
        this.received.push(input);
        const next = this.script[index];
        index += 1;
        const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 };
        this.usage?.record(this.name, this.model, usage);
        if (!next) return { text: "done", toolCalls: [], stop: "end", usage };
        return { text: "", toolCalls: [{ ...next, id: `call-${index}` }], stop: "tool_calls", usage };
      },
    };
  }
}
