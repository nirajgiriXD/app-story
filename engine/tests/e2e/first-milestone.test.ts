import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDemo } from "@demoforge/core";
import { loadProduct } from "@demoforge/products";
import { probeMedia } from "@demoforge/shared";
import { startExampleApp } from "../support/example-app";

/*
 * README §16 — the first end-to-end milestone, against real AI and TTS APIs.
 * Costs real money, so each provider only runs when its key is present:
 *   npm run test:e2e
 */
loadEnv({ quiet: true });

const PORT = 4392;
let app: { url: string; stop: () => void };
let productsDir: string;
let outputDir: string;

beforeAll(async () => {
  app = await startExampleApp(PORT);
  const root = await mkdtemp(join(tmpdir(), "demoforge-e2e-"));
  productsDir = join(root, "products");
  outputDir = join(root, "output");
  await cp("products/example", join(productsDir, "example"), { recursive: true });
  const file = join(productsDir, "example", "product.yaml");
  await writeFile(file, (await readFile(file, "utf8")).replaceAll("4310", String(PORT)));
});

afterAll(() => app?.stop());

for (const provider of ["anthropic", "openai"] as const) {
  const key = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  describe.skipIf(!key)(`first milestone with ${provider}`, () => {
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
