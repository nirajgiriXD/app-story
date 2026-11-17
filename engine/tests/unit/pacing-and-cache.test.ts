import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRehearsal, type AIProvider, type AgentInput, type AgentTurnResult, type ToolCall } from "@app-story/ai";
import type { Step } from "@app-story/contracts";
import { frameTimes } from "@app-story/browser";
import { cacheKey, storeFor } from "@app-story/core";
import { kokoroDtype, segmentWordBudget } from "@app-story/narration";
import { applyOverrides, parseProductFile } from "@app-story/products";
import { createSilentLogger } from "@app-story/shared";
import { estimateStepMs } from "@app-story/workflow";
import { FakeController } from "../support/fake-controller";

const pacing = { minStepMs: 900, typingDelayMs: 45, cursorMoveMs: 650 };
const step = (o: Partial<Step> & Pick<Step, "id" | "action">): Step => ({ description: o.id, ...o }) as Step;

describe("narration sized to the recording", () => {
  it("estimates how long each step is on screen, with long typing capped", () => {
    const click = estimateStepMs(step({ id: "a", action: "click", target: { name: "Save" } }), pacing);
    const shortFill = estimateStepMs(step({ id: "b", action: "fill", target: { label: "Name" }, value: "Q3 launch" }), pacing);
    const longFill = estimateStepMs(step({ id: "c", action: "fill", target: { label: "Notes" }, value: "x".repeat(2000) }), pacing);
    expect(click).toBeGreaterThanOrEqual(pacing.minStepMs);
    expect(shortFill).toBeGreaterThan(click - 600);
    expect(longFill).toBeLessThan(5000); // typing on camera stops after ~2.5s
  });

  it("asks for about as many words as the steps take to show, never more than the length allows", () => {
    const steps = ["a", "b", "c", "d"].map((id) => step({ id, action: "click", target: { name: id } }));
    const times = { a: 2000, b: 2000, c: 2000, d: 2000 }; // 8s of action
    const fitted = segmentWordBudget(steps, times, 90);
    expect(fitted).toBeGreaterThanOrEqual(20);
    expect(fitted).toBeLessThanOrEqual(30); // not the ~169 words a 90s video would allow
    expect(segmentWordBudget(steps, { a: 60_000, b: 60_000, c: 60_000, d: 60_000 }, 30)).toBe(Math.round(30 * 2.5 * 0.75));
  });
});

/** Answers each agent turn with a fixed batch of tool calls. */
class BatchProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "batch";
  readonly received: AgentInput[] = [];
  constructor(private readonly turns: Omit<ToolCall, "id">[][]) {}
  async generateText(): Promise<string> {
    return "";
  }
  async generateStructuredOutput<T>(): Promise<T> {
    throw new Error("unused");
  }
  startAgentSession() {
    let turn = 0;
    return {
      send: async (input: AgentInput): Promise<AgentTurnResult> => {
        this.received.push(input);
        const calls = this.turns[turn] ?? [];
        turn += 1;
        const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        return { text: "", toolCalls: calls.map((c, i) => ({ ...c, id: `t${turn}-${i}` })), stop: calls.length ? "tool_calls" : "end", usage };
      },
    };
  }
}

const T = (name: string) => ({ role: null, name, label: null, text: null, placeholder: null, test_id: null, css: null, nth: null });
const click = (name: string) => ({ name: "click", input: { description: name, section: null, target: T(name), expected: null } });

describe("several actions in one agent turn", () => {
  it("runs them in order, sends the page once, and skips the rest after a failure", async () => {
    const controller = new FakeController();
    const provider = new BatchProvider([
      [click("New project"), click("Create project")],
      [click("Nope"), click("New project")],
      [{ name: "give_up", input: { reason: "x", category: "other" } }],
    ]);
    await runRehearsal({
      provider,
      controller,
      product: { name: "App", description: "d", baseUrl: "http://app.test" },
      objective: "o",
      targetDurationS: 60,
      maxIterations: 6,
      maxDurationS: 60,
      log: createSilentLogger(),
    });

    const results = provider.received.filter((r) => r.type === "tool_results").map((r) => (r.type === "tool_results" ? r.results : []));
    const [first = [], second = []] = results;
    expect(first[0]!.content).not.toContain("<page_content>"); // not the last call of the turn
    expect(first[1]!.content).toContain("<page_content>");
    expect(second[0]).toMatchObject({ isError: true });
    expect(second[0]!.content).toContain("<page_content>"); // a failure always shows the page
    expect(second[1]).toMatchObject({ isError: true, content: expect.stringMatching(/^Skipped/) });
    expect(controller.actions.filter((a) => a.includes("New project"))).toHaveLength(1);
  });
});

describe("result cache", () => {
  it("keeps text and audio by key, and the key depends on every input", async () => {
    const store = storeFor(join(await mkdtemp(join(tmpdir(), "df-cache-")), "output"));
    const key = cacheKey("speech", { voice: "af_heart", text: "Hello" });
    expect(key).not.toBe(cacheKey("speech", { voice: "af_heart", text: "Hello!" }));
    expect(store.getCachedBlob(key)).toBeUndefined();
    store.setCached(key, "speech", Buffer.from([1, 2, 3]));
    expect([...(store.getCachedBlob(key) ?? [])]).toEqual([1, 2, 3]);
    store.setCached("features:x", "features", '{"a":1}');
    expect(store.getCachedText("features:x")).toBe('{"a":1}');
  });
});

describe("APP_STORY_AI_EFFORT", () => {
  afterEach(() => {
    delete process.env.APP_STORY_AI_EFFORT;
  });

  it("sets the effort for every AI step, and rejects unknown levels", () => {
    const { config } = parseProductFile("---\nurl: https://acme.test\n---\n\n# Acme\n", "acme.md", "acme");
    expect(applyOverrides(config).providers.ai.effort).toBeUndefined();
    process.env.APP_STORY_AI_EFFORT = "High";
    expect(applyOverrides(config).providers.ai.effort).toBe("high");
    process.env.APP_STORY_AI_EFFORT = "turbo";
    expect(() => applyOverrides(config)).toThrow(/APP_STORY_AI_EFFORT/);
  });
});

describe("screen recording clock", () => {
  it("puts Chromium's frame times on Node's clock, whatever the gap between the two", () => {
    // Chromium's clock is 11.6 s behind; frames arrive 20-40 ms after they are drawn.
    const behind = 11_600;
    const frames = [
      { drawnAt: 1000 - behind, receivedAt: 1030 },
      { drawnAt: 1500 - behind, receivedAt: 1520 },
      { drawnAt: 4000 - behind, receivedAt: 4040 },
    ];
    expect(frameTimes(frames)).toEqual([1020, 1520, 4020]);
  });

  it("uses arrival times when Chromium gives none, and never goes back in time", () => {
    expect(frameTimes([{ receivedAt: 100 }, { receivedAt: 90 }, { receivedAt: 300 }])).toEqual([100, 100, 300]);
  });
});

describe("local voice model", () => {
  afterEach(() => {
    delete process.env.APP_STORY_KOKORO_DTYPE;
  });

  it("loads the full-precision model unless told otherwise", () => {
    expect(kokoroDtype()).toBe("fp32");
    process.env.APP_STORY_KOKORO_DTYPE = "Q8";
    expect(kokoroDtype()).toBe("q8");
    process.env.APP_STORY_KOKORO_DTYPE = "tiny";
    expect(() => kokoroDtype()).toThrow(/APP_STORY_KOKORO_DTYPE/);
  });
});
