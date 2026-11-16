import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AIProvider } from "@demoforge/ai";
import { ProductConfigSchema, type FeaturePlan } from "@demoforge/contracts";
import { planFromReleaseNotes } from "@demoforge/core";
import { createTTSProvider } from "@demoforge/narration";
import { loadProduct, objectiveForAllFeatures, objectiveForFeature } from "@demoforge/products";
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

async function productWithNotes(notes: string | undefined, extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "df-notes-"));
  await mkdir(join(dir, "shop"));
  const config = { version: 1, product: { id: "shop", name: "Shop", description: "A shop", base_url: "https://shop.test" }, providers: { ai: { provider: "anthropic" }, ...extra } };
  await writeFile(join(dir, "shop", "product.yaml"), JSON.stringify(config));
  if (notes !== undefined) await writeFile(join(dir, "shop", "features.md"), notes);
  return loadProduct(dir, "shop");
}

describe("release notes", () => {
  it("lets the AI pick the demoable features from notes in any format", async () => {
    const product = await productWithNotes(CHANGELOG);
    const ai = new ScriptedProvider([], { feature_plan: PLAN });
    const result = await planFromReleaseNotes({ product, logLevel: "silent", providers: { createAI: () => ai } });

    expect(result.plan.features.map((f) => f.title)).toEqual(["Bulk export", "Dark mode"]);
    expect(result.plan.skipped).toHaveLength(1);
    // The notes are sent once, as data, and not again as product knowledge.
    const prompt = ai.structuredPrompts[0] as string;
    expect(prompt).toContain(`<release_notes>\n${CHANGELOG}`);
    expect(prompt.split("Bulk export: tick rows")).toHaveLength(2);
  });

  it("refuses notes that have nothing to show, and says why", async () => {
    const product = await productWithNotes("### Fixed\n- Crash when saving an empty report.\n");
    const ai = new ScriptedProvider([], { feature_plan: { title: null, features: [], skipped: PLAN.skipped } });
    const error = await planFromReleaseNotes({ product, logLevel: "silent", providers: { createAI: () => ai } }).catch((e) => e);
    expect(error).toBeInstanceOf(DemoForgeError);
    expect(error.code).toBe("UNSUPPORTED_WORKFLOW");
    expect(error.message).toContain("Crash when saving an empty report (bug fix with nothing to show)");
  });

  it("reports a missing or empty notes file before calling the AI", async () => {
    const createAI = () => {
      throw new Error("must not be called");
    };
    // Missing, blank, or only the instructions comment that `init` writes.
    for (const notes of [undefined, "  \n", "<!--\nPaste your release notes below.\n-->\n"]) {
      const product = await productWithNotes(notes);
      await expect(planFromReleaseNotes({ product, logLevel: "silent", providers: { createAI } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  it("uses the configured fallback provider when the main one fails", async () => {
    const product = await productWithNotes(CHANGELOG, { ai_fallback: { provider: "openai" } });
    const failing = {
      name: "anthropic",
      model: "down",
      generateStructuredOutput: async () => {
        throw new DemoForgeError("PROVIDER_ERROR", "outage");
      },
    } as unknown as AIProvider;
    const backup = new ScriptedProvider([], { feature_plan: PLAN });
    const result = await planFromReleaseNotes({
      product,
      logLevel: "silent",
      providers: { createAI: (config) => (config.provider === "openai" ? backup : failing) },
    });
    expect(result.plan.features).toHaveLength(2);
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
