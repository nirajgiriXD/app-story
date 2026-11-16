import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider, registerAIProvider, UsageTracker } from "@app-story/ai";
import { createSilentLogger } from "@app-story/shared";
import { openCassette } from "../support/cassette";
import { ScriptedProvider } from "../support/fakes";

const limits = { max_iterations: 10, max_duration_s: 60, max_retries: 0 };
const config = { provider: "anthropic" as const, ...limits };
const deps = () => ({ usage: new UsageTracker(), log: createSilentLogger() });
const Script = z.object({ intro: z.string() });

/** One of each kind of request, as the real flow makes them. */
async function conversation(createAI: ReturnType<typeof openCassette>["createAI"], d = deps()) {
  const ai = createAI(config, d);
  const structured = await ai.generateStructuredOutput({ system: "s", prompt: "p", schema: Script, schemaName: "narration_script" });
  const session = ai.startAgentSession({ system: "s", tools: [] });
  const turns = [await session.send({ type: "user", text: "go" }), await session.send({ type: "tool_results", results: [] })];
  const text = await ai.generateText({ system: "s", prompt: "p" });
  return { name: ai.name, model: ai.model, structured, turns, text, usage: d.usage.summary() };
}

describe("recorded AI answers", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeAll(() => {
    // A stand-in for the real API, so recording can be tested without a key or the network.
    process.env.ANTHROPIC_API_KEY = "sk-cassette-test";
    registerAIProvider("anthropic", (_config, d) =>
      Object.assign(new ScriptedProvider([{ name: "click", input: { description: "Open the form" } }], { narration_script: { intro: "Hello there." } }), {
        usage: d.usage,
      }),
    );
  });
  afterAll(() => {
    registerAIProvider("anthropic", (c, d) => new AnthropicProvider(c, d));
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("replays exactly what was recorded, usage included, without the provider", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "df-cassette-")), "anthropic.json");
    const recording = openCassette(file, "record");
    const live = await conversation(recording.createAI);
    await recording.save();

    // Replaying never creates the real provider: no key is needed.
    delete process.env.ANTHROPIC_API_KEY;
    const replayed = await conversation(openCassette(file, "replay").createAI);
    expect(replayed).toEqual(live);
    expect(replayed.turns[0]?.toolCalls[0]?.name).toBe("click");
    expect(replayed.usage.requests).toBe(2);
  });

  it("says to record again when the flow asks for more than was recorded", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-cassette-test";
    const file = join(await mkdtemp(join(tmpdir(), "df-cassette-")), "anthropic.json");
    const recording = openCassette(file, "record");
    await recording.createAI(config, deps()).generateText({ system: "s", prompt: "p" });
    await recording.save();

    const ai = openCassette(file, "replay").createAI(config, deps());
    await ai.generateText({ system: "s", prompt: "p" });
    await expect(ai.generateText({ system: "s", prompt: "p" })).rejects.toThrow(/record again with APP_STORY_RECORD_AI=1/);
    expect(() => openCassette(file, "replay").createAI({ provider: "openai", ...limits }, deps())).toThrow(/no answers from openai/);
  });
});
