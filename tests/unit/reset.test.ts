import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetDemoData } from "@app-story/core";
import { parseProductFile, type LoadedProduct } from "@app-story/products";
import { createSilentLogger, isAppStoryError } from "@app-story/shared";

async function productWith(reset: string): Promise<{ product: LoadedProduct; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "app-story-reset-"));
  const dir = join(root, "apps");
  await mkdir(dir);
  const { config, brief } = parseProductFile(`---\nurl: https://acme.test\nreset: ${JSON.stringify(reset)}\n---\n\n# Acme\n`, "acme.md", "acme");
  return { product: { id: "acme", file: join(dir, "acme.md"), dir, config, brief }, root };
}

const log = createSilentLogger();

describe("putting the demo data back (reset:)", () => {
  afterEach(() => {
    delete process.env.RESET_TOKEN;
  });

  it("runs a command in the project folder", async () => {
    const { product, root } = await productWith(`node -e "require('fs').writeFileSync('reset.txt', 'done')"`);
    await resetDemoData(product, log, "a test");
    expect(await readFile(join(root, "reset.txt"), "utf8")).toBe("done");
  });

  it("stops the job when the command fails, with its output", async () => {
    const { product } = await productWith(`node -e "console.error('seed failed'); process.exit(3)"`);
    const error = await resetDemoData(product, log, "a test").catch((e: unknown) => e);
    expect(isAppStoryError(error) && error.code).toBe("RESET_FAILED");
    expect((error as Error).message).toMatch(/exit code 3.*seed failed/s);
  });

  it("sends a POST to an address, with a token from the environment kept secret", async () => {
    const seen: { method?: string; url?: string }[] = [];
    const server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url });
      res.statusCode = req.url?.includes("bad") ? 500 : 204;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      process.env.RESET_TOKEN = "s3cret-token";
      const ok = await productWith(`http://127.0.0.1:${port}/reset?token={{env:RESET_TOKEN}}`);
      await resetDemoData(ok.product, log, "a test");
      expect(seen).toEqual([{ method: "POST", url: "/reset?token=s3cret-token" }]);

      const bad = await productWith(`http://127.0.0.1:${port}/bad?token={{env:RESET_TOKEN}}`);
      const error = await resetDemoData(bad.product, log, "a test").catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/HTTP 500/);
    } finally {
      server.close();
    }
  });

  it("does nothing without reset:", async () => {
    const { config, brief } = parseProductFile("---\nurl: https://acme.test\n---\n", "acme.md", "acme");
    await expect(resetDemoData({ id: "acme", file: "acme.md", dir: ".", config, brief }, log, "a test")).resolves.toBeUndefined();
  });
});
