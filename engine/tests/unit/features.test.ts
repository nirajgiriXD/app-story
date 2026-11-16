import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AIProvider } from "@demoforge/ai";
import { ProductConfigSchema, resolveKokoroVoice, type FeaturePlan } from "@demoforge/contracts";
import { planFeatures } from "@demoforge/core";
import { createTTSProvider } from "@demoforge/narration";
import { applyVoiceSettings, loadProduct, objectiveForAllFeatures, objectiveForFeature } from "@demoforge/products";
import { DemoForgeError } from "@demoforge/shared";
import { ScriptedProvider } from "../support/fakes";

/** A typical changelog: section headings, bullets, and a fix with nothing to show. */
const CHANGELOG = `## [2.4.0] - 2026-11-01
### Added
- Bulk export: tick rows on the Reports page and export them as CSV.
- Dark mode (moon icon in the top bar).
### Fixed
- Crash when saving an empty report.
`;

const PLAN: FeaturePlan = {
  title: "2.4.0",
  features: [
    { title: "Bulk export", details: "Tick rows on the Reports page and export them as CSV." },
    { title: "Dark mode", details: "Moon icon in the top bar." },
  ],
  skipped: [{ item: "Crash when saving an empty report", reason: "bug fix with nothing to show" }],
};

/** A product file whose body is `body` (below a settings block with a password). */
async function productWith(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "df-notes-"));
  await writeFile(join(dir, "shop.md"), `---\nurl: https://shop.test\nlogin: me@shop.test / top-secret-pw\n---\n${body}`);
  return loadProduct(dir, "shop");
}

const SHOP = `# Shop\n\nA web shop for bakeries.\n\n## Release notes\n${CHANGELOG}`;

describe("picking features from the product file", () => {
  it("lets the AI pick the demoable features from release notes in any format", async () => {
    const product = await productWith(SHOP);
    const ai = new ScriptedProvider([], { feature_plan: PLAN });
    const result = await planFeatures({ product, logLevel: "silent", providers: { createAI: () => ai } });

    expect(result.plan.features.map((f) => f.title)).toEqual(["Bulk export", "Dark mode"]);
    expect(result.plan.skipped).toHaveLength(1);
    // The product file is sent once, as data; its settings block (and password) never.
    const prompt = ai.structuredPrompts[0] as string;
    expect(prompt).toContain(`<product_file>\n${SHOP.trim()}\n</product_file>`);
    expect(prompt.split("Bulk export: tick rows")).toHaveLength(2);
    expect(prompt).not.toContain("top-secret-pw");
  });

  it("refuses a file with nothing new to show, and says why", async () => {
    const product = await productWith("# Shop\n\n## Release notes\n### Fixed\n- Crash when saving an empty report.\n");
    const ai = new ScriptedProvider([], { feature_plan: { title: null, features: [], skipped: PLAN.skipped } });
    const error = await planFeatures({ product, logLevel: "silent", providers: { createAI: () => ai } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DemoForgeError);
    expect((error as DemoForgeError).code).toBe("UNSUPPORTED_WORKFLOW");
    expect((error as DemoForgeError).message).toContain("Crash when saving an empty report (bug fix with nothing to show)");
  });

  it("reports an empty product file before calling the AI", async () => {
    const createAI = () => {
      throw new Error("must not be called");
    };
    // Blank, or only the <!-- --> hints that `new` writes.
    for (const body of ["  \n", "<!--\nPaste your release notes below.\n-->\n"]) {
      const product = await productWith(body);
      await expect(planFeatures({ product, logLevel: "silent", providers: { createAI } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  it("uses the backup AI when the main one fails", async () => {
    const saved = [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY];
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test"; // both keys: openai becomes the backup
    try {
      const product = await productWith(SHOP);
      const failing = {
        name: "anthropic",
        model: "down",
        generateStructuredOutput: async () => {
          throw new DemoForgeError("PROVIDER_ERROR", "outage");
        },
      } as unknown as AIProvider;
      const backup = new ScriptedProvider([], { feature_plan: PLAN });
      const result = await planFeatures({
        product,
        logLevel: "silent",
        providers: { createAI: (config) => (config.provider === "openai" ? backup : failing) },
      });
      expect(result.plan.features).toHaveLength(2);
    } finally {
      [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY] = saved;
      if (saved[0] === undefined) delete process.env.ANTHROPIC_API_KEY;
      if (saved[1] === undefined) delete process.env.OPENAI_API_KEY;
    }
  });

  it("builds objectives that name every feature in order, with its details", () => {
    const all = objectiveForAllFeatures(PLAN);
    expect(all).toContain('"2.4.0"');
    expect(all.indexOf("1. Bulk export: Tick rows")).toBeLessThan(all.indexOf("2. Dark mode: Moon icon"));
    expect(objectiveForFeature(PLAN.features[1]!)).toBe('Demonstrate the feature "Dark mode".\n\nMoon icon in the top bar.');
    expect(objectiveForAllFeatures({ title: null, features: [PLAN.features[0]!] })).toBe(objectiveForFeature(PLAN.features[0]!));
  });
});

describe("text-to-speech selection", () => {
  const saved = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });

  it("defaults to the free local voice when tts is not configured", () => {
    const config = ProductConfigSchema.parse({
      version: 1,
      product: { id: "acme", name: "Acme", description: "Test", base_url: "https://acme.test" },
      providers: { ai: { provider: "anthropic" } },
    });
    expect(config.providers.tts.provider).toBe("kokoro");
  });

  it("kokoro needs no API key", () => {
    delete process.env.OPENAI_API_KEY;
    const tts = createTTSProvider({ provider: "kokoro", speed: 1 });
    expect([tts.name, tts.voice, tts.silent]).toEqual(["kokoro", "af_heart", undefined]);
  });

  it("none is always silent", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(createTTSProvider({ provider: "none", speed: 1 }).silent).toBe(true);
  });
});

describe("voice settings from .env", () => {
  const kokoro = { provider: "kokoro" as const, speed: 1 };
  const voiceOf = (env: Record<string, string>, base: Parameters<typeof applyVoiceSettings>[0] = kokoro) =>
    createTTSProvider(applyVoiceSettings(base, env)).voice;

  it("picks the best Kokoro voice for a gender and accent", () => {
    expect(voiceOf({})).toBe("af_heart");
    expect(voiceOf({ DEMOFORGE_VOICE: "male" })).toBe("am_michael");
    expect(voiceOf({ DEMOFORGE_VOICE: "Female", DEMOFORGE_VOICE_ACCENT: "British" })).toBe("bf_emma");
    expect(voiceOf({ DEMOFORGE_VOICE: "male", DEMOFORGE_VOICE_ACCENT: "british" })).toBe("bm_george");
    expect(resolveKokoroVoice("male", "british")).toMatchObject({ name: "George", gender: "male", accent: "british" });
  });

  it("accepts a Kokoro voice by id or name", () => {
    expect(voiceOf({ DEMOFORGE_VOICE: "am_puck" })).toBe("am_puck");
    expect(voiceOf({ DEMOFORGE_VOICE: "Emma" })).toBe("bf_emma");
  });

  it("reads speed and tone", () => {
    const tts = applyVoiceSettings({ provider: "openai", speed: 1 }, { DEMOFORGE_VOICE: "cedar", DEMOFORGE_VOICE_SPEED: "1.15", DEMOFORGE_VOICE_TONE: "warm and upbeat" });
    expect(tts).toMatchObject({ voice: "cedar", speed: 1.15, style: "warm and upbeat" });
  });

  it("rejects mistakes before any AI work, with the fix in the message", () => {
    expect(() => applyVoiceSettings(kokoro, { DEMOFORGE_VOICE: "robot" })).toThrow(/Unknown voice 'robot'/);
    try {
      applyVoiceSettings(kokoro, { DEMOFORGE_VOICE: "robot" });
    } catch (error) {
      expect((error as DemoForgeError).hint).toContain("am_michael");
    }
    expect(() => applyVoiceSettings(kokoro, { DEMOFORGE_VOICE_ACCENT: "australian" })).toThrow(/american or british/);
    expect(() => applyVoiceSettings(kokoro, { DEMOFORGE_VOICE_SPEED: "2" })).toThrow(/0.7 .* to 1.3/);
    expect(() => applyVoiceSettings({ provider: "openai", speed: 1 }, { DEMOFORGE_VOICE: "male" })).toThrow(/only the free Kokoro voice/);
  });

  it("applies to every product through the loader", async () => {
    process.env.DEMOFORGE_VOICE = "male";
    try {
      const product = await productWith("# Shop\n");
      expect(product.config.providers.tts).toMatchObject({ provider: "kokoro", voice: "male" });
      expect(createTTSProvider(product.config.providers.tts).voice).toBe("am_michael");
    } finally {
      delete process.env.DEMOFORGE_VOICE;
    }
  });
});
