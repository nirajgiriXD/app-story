import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider, LocalProvider, OpenAIProvider, UsageTracker, localBaseUrl, stripNulls, toStrictJsonSchema, type AIProvider } from "@app-story/ai";
import { AiProviderConfigSchema, type AiProviderConfig } from "@app-story/contracts";
import { ChatterboxTTS, chatterboxWorkerPath, createTTSProvider } from "@app-story/narration";
import { createSilentLogger } from "@app-story/shared";

/*
 * The same contract runs against both providers with their SDK clients mocked.
 * Each harness turns a neutral "reply" into that SDK's native response shape and
 * records the native requests so we can check what was sent.
 */
type Reply =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "refusal" }
  | { kind: "structured"; value: unknown }
  | { kind: "rate_limit" };

interface Harness {
  name: string;
  make(replies: Reply[], config?: Partial<AiProviderConfig>): { provider: AIProvider; requests: Record<string, unknown>[]; usage: UsageTracker };
}

const usageA = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 };
const usageO = {
  input_tokens: 14,
  output_tokens: 5,
  total_tokens: 19,
  input_tokens_details: { cached_tokens: 4 },
  output_tokens_details: { reasoning_tokens: 0 },
};

const anthropic: Harness = {
  name: "anthropic",
  make(replies, config = {}) {
    const requests: Record<string, unknown>[] = [];
    const next = (params: Record<string, unknown>) => {
      requests.push(JSON.parse(JSON.stringify(params)));
      const r = replies.shift();
      if (!r) throw new Error("no reply");
      if (r.kind === "rate_limit") throw Object.create(Anthropic.RateLimitError.prototype);
      const content =
        r.kind === "text" ? [{ type: "text", text: r.text }] : r.kind === "tool" ? [{ type: "tool_use", id: r.id, name: r.name, input: r.input }] : [];
      return {
        id: "msg",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content,
        stop_reason: r.kind === "refusal" ? "refusal" : r.kind === "tool" ? "tool_use" : "end_turn",
        stop_details: r.kind === "refusal" ? { type: "refusal", category: "cyber", explanation: null } : null,
        usage: usageA,
        parsed_output: r.kind === "structured" ? r.value : undefined,
      };
    };
    const client = {
      messages: {
        create: async (p: Record<string, unknown>) => next(p),
        parse: async (p: Record<string, unknown>) => next(p),
        stream: (p: Record<string, unknown>) => ({ finalMessage: async () => next(p) }),
      },
    } as unknown as Anthropic;
    const usage = new UsageTracker();
    const provider = new AnthropicProvider(AiProviderConfigSchema.parse({ provider: "anthropic", ...config }), { usage, log: createSilentLogger(), client });
    return { provider, requests, usage };
  },
};

const openai: Harness = {
  name: "openai",
  make(replies) {
    const requests: Record<string, unknown>[] = [];
    let n = 0;
    const next = (params: Record<string, unknown>) => {
      requests.push(JSON.parse(JSON.stringify(params)));
      const r = replies.shift();
      if (!r) throw new Error("no reply");
      if (r.kind === "rate_limit") throw Object.create(OpenAI.RateLimitError.prototype);
      n += 1;
      const output =
        r.kind === "tool"
          ? [{ type: "function_call", call_id: r.id, name: r.name, arguments: JSON.stringify(r.input) }]
          : r.kind === "refusal"
            ? [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }]
            : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: r.kind === "text" ? r.text : "{}" }] }];
      return {
        id: `resp_${n}`,
        status: "completed",
        output,
        output_text: r.kind === "text" ? r.text : "",
        output_parsed: r.kind === "structured" ? r.value : null,
        usage: usageO,
      };
    };
    const client = {
      responses: { create: async (p: Record<string, unknown>) => next(p), parse: async (p: Record<string, unknown>) => next(p) },
    } as unknown as OpenAI;
    const usage = new UsageTracker();
    const provider = new OpenAIProvider(AiProviderConfigSchema.parse({ provider: "openai" }), { usage, log: createSilentLogger(), client });
    return { provider, requests, usage };
  },
};

/** A local server (Ollama, LM Studio, vLLM): the OpenAI Chat Completions API. */
const local: Harness = {
  name: "local",
  make(replies) {
    const requests: Record<string, unknown>[] = [];
    const create = async (params: Record<string, unknown>) => {
      requests.push(JSON.parse(JSON.stringify(params)));
      const r = replies.shift();
      if (!r) throw new Error("no reply");
      if (r.kind === "rate_limit") throw Object.create(OpenAI.RateLimitError.prototype);
      const message =
        r.kind === "tool"
          ? {
              role: "assistant",
              content: null,
              refusal: null,
              tool_calls: [{ id: r.id, type: "function", function: { name: r.name, arguments: JSON.stringify(r.input) } }],
            }
          : r.kind === "refusal"
            ? { role: "assistant", content: null, refusal: "no" }
            : { role: "assistant", content: r.kind === "text" ? r.text : `\`\`\`json\n${JSON.stringify(r.value)}\n\`\`\``, refusal: null };
      return {
        id: "chatcmpl",
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: r.kind === "tool" ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19, prompt_tokens_details: { cached_tokens: 4 } },
      };
    };
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const usage = new UsageTracker();
    const provider = new LocalProvider(AiProviderConfigSchema.parse({ provider: "local", model: "qwen3:32b" }), { usage, log: createSilentLogger(), client });
    return { provider, requests, usage };
  },
};

const Schema = z.object({ title: z.string(), count: z.number() });
const tool = { name: "click", description: "Click", inputSchema: z.object({ target: z.string(), note: z.string().nullable() }) };

for (const h of [anthropic, openai, local]) {
  describe(`${h.name} provider contract`, () => {
    it("generates text and tracks usage", async () => {
      const { provider, usage } = h.make([{ kind: "text", text: "hello" }]);
      expect(await provider.generateText({ system: "s", prompt: "p" })).toBe("hello");
      const summary = usage.summary();
      expect(summary.requests).toBe(1);
      expect(summary.cached_input_tokens).toBe(4);
      expect(summary.by_model[0]?.provider).toBe(h.name);
    });

    it("returns validated structured output", async () => {
      const { provider } = h.make([{ kind: "structured", value: { title: "x", count: 2 } }]);
      expect(await provider.generateStructuredOutput({ system: "s", prompt: "p", schema: Schema, schemaName: "thing" })).toEqual({ title: "x", count: 2 });
    });

    it("sends pictures before the prompt in a structured request", async () => {
      const { provider, requests } = h.make([{ kind: "structured", value: { title: "x", count: 2 } }]);
      const image = { mediaType: "image/jpeg" as const, data: Buffer.from("jpeg-bytes") };
      await provider.generateStructuredOutput({ system: "s", prompt: "look", schema: Schema, schemaName: "thing", images: [image] });
      const sent = JSON.stringify(requests[0]);
      const b64 = image.data.toString("base64");
      expect(sent).toContain(b64);
      expect(sent.indexOf(b64)).toBeLessThan(sent.indexOf('"look"'));
    });

    it("rejects structured output that does not match the schema", async () => {
      const { provider } = h.make([{ kind: "structured", value: { title: 1 } }]);
      await expect(provider.generateStructuredOutput({ system: "s", prompt: "p", schema: Schema, schemaName: "thing" })).rejects.toMatchObject({
        code: "PROVIDER_INVALID_OUTPUT",
      });
    });

    it("normalises tool calls and sends tool results back", async () => {
      const { provider, requests } = h.make([
        { kind: "tool", id: "call_1", name: "click", input: { target: "Save", note: null } },
        { kind: "text", text: "done" },
      ]);
      const session = provider.startAgentSession({ system: "sys", tools: [tool] });
      const turn = await session.send({ type: "user", text: "go" });
      expect(turn.stop).toBe("tool_calls");
      expect(turn.toolCalls).toEqual([{ id: "call_1", name: "click", input: { target: "Save", note: null } }]);
      const second = await session.send({ type: "tool_results", results: [{ callId: "call_1", content: "ok" }] });
      expect(second.stop).toBe("end");
      expect(second.text).toBe("done");
      // The second native request carries the tool result for call_1.
      expect(JSON.stringify(requests[1])).toContain("call_1");
      expect(JSON.stringify(requests[1])).toContain("ok");
      // Tools are sent in strict mode.
      expect(JSON.stringify(requests[0])).toContain('"strict":true');
    });

    it("surfaces refusals as a typed error", async () => {
      const { provider } = h.make([{ kind: "refusal" }]);
      await expect(provider.generateText({ system: "s", prompt: "p" })).rejects.toMatchObject({ code: "PROVIDER_REFUSAL" });
    });

    it("maps rate limits to a retryable provider error", async () => {
      const { provider } = h.make([{ kind: "rate_limit" }]);
      await expect(provider.generateText({ system: "s", prompt: "p" })).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMIT", retryable: true });
    });
  });
}

describe("a local AI server", () => {
  it("needs the server's address and a model name", () => {
    expect(() => localBaseUrl({})).toThrow(/APP_STORY_AI_BASE_URL is not set/);
    expect(localBaseUrl({ APP_STORY_AI_BASE_URL: "http://localhost:11434/v1" })).toBe("http://localhost:11434/v1");
    const deps = { usage: new UsageTracker(), log: createSilentLogger(), client: {} as OpenAI };
    expect(() => new LocalProvider(AiProviderConfigSchema.parse({ provider: "local" }), deps)).toThrow(/needs a model name/);
  });

  it("asks for JSON matching the schema, and reads it even inside a code fence", async () => {
    const { provider, requests } = local.make([{ kind: "structured", value: { title: "x", count: 2 } }]);
    expect(await provider.generateStructuredOutput({ system: "s", prompt: "p", schema: Schema, schemaName: "thing" })).toEqual({ title: "x", count: 2 });
    expect(requests[0]).toMatchObject({ model: "qwen3:32b", response_format: { type: "json_schema", json_schema: { name: "thing", strict: true } } });
  });
});

describe("provider-specific request details", () => {
  it("never sends temperature to Claude and uses effort instead", async () => {
    const { provider, requests } = anthropic.make([{ kind: "text", text: "x" }]);
    await provider.generateText({ system: "s", prompt: "p" });
    expect(requests[0]).not.toHaveProperty("temperature");
    expect(requests[0]).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high" } });
  });

  it("uses the phase's effort unless the config sets one", async () => {
    const phase = anthropic.make([{ kind: "text", text: "x" }]);
    await phase.provider.generateText({ system: "s", prompt: "p", effort: "low" });
    expect(phase.requests[0]).toMatchObject({ output_config: { effort: "low" } });

    const configured = anthropic.make([{ kind: "text", text: "x" }], { effort: "xhigh" });
    await configured.provider.generateText({ system: "s", prompt: "p", effort: "low" });
    expect(configured.requests[0]).toMatchObject({ output_config: { effort: "xhigh" } });
  });

  it("chains OpenAI turns with previous_response_id", async () => {
    const { provider, requests } = openai.make([
      { kind: "tool", id: "c1", name: "click", input: { target: "a", note: null } },
      { kind: "text", text: "done" },
    ]);
    const session = provider.startAgentSession({ system: "sys", tools: [tool] });
    await session.send({ type: "user", text: "go" });
    await session.send({ type: "tool_results", results: [{ callId: "c1", content: "ok" }] });
    expect(requests[1]).toMatchObject({ previous_response_id: "resp_1" });
  });
});

describe("strict JSON schema", () => {
  it("closes every object and requires every property", () => {
    const schema = toStrictJsonSchema(z.object({ a: z.string(), b: z.object({ c: z.number().nullable() }) }));
    expect(schema).toMatchObject({ type: "object", required: ["a", "b"], additionalProperties: false });
    expect((schema.properties as Record<string, Record<string, unknown>>).b).toMatchObject({ required: ["c"], additionalProperties: false });
    expect(schema).not.toHaveProperty("$schema");
  });

  it("strips nulls back to missing keys", () => {
    expect(stripNulls({ a: 1, b: null, c: { d: null, e: "x" } })).toEqual({ a: 1, c: { e: "x" } });
  });
});

describe("Chatterbox voice", () => {
  it("ships its Python helper", () => {
    expect(existsSync(chatterboxWorkerPath())).toBe(true);
  });

  it("says how to install it when Python is missing", async () => {
    process.env.APP_STORY_PYTHON = "no-such-python-app-story";
    try {
      const tts = createTTSProvider({ provider: "chatterbox", speed: 1 });
      expect(tts.name).toBe("chatterbox");
      await expect(tts.synthesize("Hello.", "out.wav")).rejects.toMatchObject({
        code: "DEPENDENCY_MISSING",
        hint: expect.stringMatching(/pip install chatterbox-tts/),
      });
    } finally {
      delete process.env.APP_STORY_PYTHON;
    }
  });

  it("copies a voice from an audio file and uses its own voice otherwise", () => {
    expect(new ChatterboxTTS({ provider: "chatterbox", speed: 1, voice: "me.wav" }).voice).toMatch(/me\.wav$/);
    expect(new ChatterboxTTS({ provider: "chatterbox", speed: 1, voice: "female" }).voice).toBe("default");
  });
});
