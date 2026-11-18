import { describe, expect, it } from "vitest";
import type { AIProvider } from "@app-story/ai";
import type { NarrationScript, Workflow } from "@app-story/contracts";
import { ChatterboxTTS, TONE_GUIDANCE, writeNarrationScript } from "@app-story/narration";
import { applyOverrides, parseProductFile } from "@app-story/products";

const workflow = {
  id: "w",
  title: "Export invoices",
  objective: "Show bulk export",
  steps: [{ id: "s1", description: "Open reports", action: "click", target: { name: "Reports" } }],
} as unknown as Workflow;

/** A provider that keeps the prompt it was given and answers with a fixed script. */
function promptCatcher(): { provider: AIProvider; prompts: string[] } {
  const prompts: string[] = [];
  const script: NarrationScript = { intro: "Hi.", segments: [{ step_ids: ["s1"], text: "Open the reports." }], outro: "Bye." };
  const provider = {
    name: "anthropic",
    model: "test",
    generateStructuredOutput: async (request: { prompt: string }) => {
      prompts.push(request.prompt);
      return script;
    },
  } as unknown as AIProvider;
  return { provider, prompts };
}

describe("tone", () => {
  it("is read from the product file, calm by default, and reaches the voice", () => {
    const parse = (settings: string) => applyOverrides(parseProductFile(`---\nurl: https://acme.test\n${settings}\n---\n# Acme\n`, "acme.md", "acme").config);
    expect(parse("").demo.tone).toBe("calm");
    const energetic = parse("tone: energetic");
    expect(energetic.demo.tone).toBe("energetic");
    expect(energetic.providers.tts.tone).toBe("energetic");
    expect(() => parse("tone: loud")).toThrow(/tone must be one of: calm, friendly, energetic/);
  });

  it("tells the script writer how to sound", async () => {
    const { provider, prompts } = promptCatcher();
    const product = { name: "Acme", description: "Billing", baseUrl: "https://acme.test" };
    await writeNarrationScript({ provider, workflow, product, language: "en", targetDurationS: 30, tone: "energetic" });
    await writeNarrationScript({ provider, workflow, product, language: "en", targetDurationS: 30 });
    expect(prompts[0]).toContain(TONE_GUIDANCE.energetic);
    expect(prompts[1]).toContain(TONE_GUIDANCE.calm);
  });

  it("makes the Chatterbox voice livelier for livelier tones, unless a voice tone is set", () => {
    const exaggeration = (tts: ChatterboxTTS) => (tts as unknown as { exaggeration: number }).exaggeration;
    expect(exaggeration(new ChatterboxTTS({ provider: "chatterbox", speed: 1, tone: "energetic" }))).toBe(0.7);
    expect(exaggeration(new ChatterboxTTS({ provider: "chatterbox", speed: 1, tone: "friendly" }))).toBe(0.6);
    expect(exaggeration(new ChatterboxTTS({ provider: "chatterbox", speed: 1, tone: "energetic", style: "calm" }))).toBe(0.5);
  });
});
