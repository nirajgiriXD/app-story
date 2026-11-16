import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDemo, planFeatures } from "@app-story/core";
import { loadProduct } from "@app-story/products";
import { probeMedia, workspace } from "@app-story/shared";
import { hasCassette, isRecordingAI, openCassette } from "../support/cassette";
import { startExampleApp } from "../support/example-app";

/*
 * The full flow with real AI answers, on the practice app.
 *
 *   npm run test:e2e                         replays the answers saved in engine/tests/fixtures/ai-answers/
 *                                            (no key, no cost, the same every time)
 *   APP_STORY_RECORD_AI=1 npm run test:e2e   asks the real AI (needs the key, costs money) and saves its answers
 *
 * Record again after changing a prompt, the agent's tools or the practice app.
 */
loadEnv({ path: workspace().envFile, quiet: true });

const PORT = 4392;
let app: { url: string; stop: () => void };
let productsDir: string;
let outputDir: string;

beforeAll(async () => {
  app = await startExampleApp(PORT);
  const root = await mkdtemp(join(tmpdir(), "app-story-e2e-"));
  productsDir = join(root, "products");
  outputDir = join(root, "output");
  await mkdir(productsDir);
  const text = (await readFile("products/example.md", "utf8")).replaceAll("4310", String(PORT));
  await writeFile(join(productsDir, "example.md"), text);
});

afterAll(() => app?.stop());

for (const provider of ["anthropic", "openai"] as const) {
  const key = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  const answers = `engine/tests/fixtures/ai-answers/${provider}.json`;
  const mode = isRecordingAI() ? (key ? "record" : undefined) : hasCassette(answers) ? "replay" : undefined;

  describe.skipIf(!mode)(`full flow with ${provider} (${mode ?? "no"} answers)`, () => {
    const cassette = mode ? openCassette(answers, mode) : undefined;
    const providers = { createAI: cassette?.createAI };
    afterAll(() => cassette?.save());

    it("picks the new feature from the release notes and skips the bug fix", async () => {
      const product = await loadProduct(productsDir, "example", { aiProvider: provider });
      const { plan } = await planFeatures({ product, logLevel: "warn", providers });
      expect(plan.features.map((f) => f.title.toLowerCase())).toEqual([expect.stringContaining("project")]);
      expect(plan.skipped.length).toBeGreaterThanOrEqual(1);
    });

    it("plans, executes, verifies, records, narrates and renders a real demo", async () => {
      const product = await loadProduct(productsDir, "example", { aiProvider: provider });
      const metadata = await generateDemo({
        product,
        outputDir,
        objective: "Demonstrate how to create a new project",
        logLevel: "info",
        providers,
      });
      console.log(`${provider}: ${metadata.status} → ${metadata.output_dir}`);
      expect(metadata.errors).toEqual([]);
      expect(["success", "success_with_warnings"]).toContain(metadata.status);
      expect(metadata.ai.provider).toBe(provider);
      const video = await probeMedia(metadata.video!.path);
      expect([video.width, video.height, video.videoCodec, video.audioCodec]).toEqual([1920, 1080, "h264", "aac"]);
    });
  });
}
