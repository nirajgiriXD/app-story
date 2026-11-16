import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDemo, planFeatures } from "@app-story/core";
import { loadProduct } from "@app-story/products";
import { ROOT_ENV_FILE, probeMedia } from "@app-story/shared";
import { startExampleApp } from "../support/example-app";

/*
 * The full flow against real AI APIs, on the practice app.
 * Costs real money, so each provider only runs when its key is present:
 *   npm run test:e2e
 */
loadEnv({ path: ROOT_ENV_FILE, quiet: true });

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
  describe.skipIf(!key)(`full flow with ${provider}`, () => {
    it("picks the new feature from the release notes and skips the bug fix", async () => {
      const product = await loadProduct(productsDir, "example", { aiProvider: provider });
      const { plan } = await planFeatures({ product, logLevel: "warn" });
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
