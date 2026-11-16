import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProductConfigSchema, WorkflowSchema } from "@demoforge/contracts";
import { applyOverrides, listProducts, loadProduct, readProductConfig, scaffoldProduct } from "@demoforge/products";
import { DemoForgeError } from "@demoforge/shared";

const minimal = {
  version: 1,
  product: { id: "acme", name: "Acme", description: "Test app", base_url: "https://demo.acme.test" },
  providers: { ai: { provider: "anthropic" }, tts: { provider: "openai" } },
};

describe("product configuration", () => {
  it("fills safe defaults", () => {
    const config = ProductConfigSchema.parse(minimal);
    expect(config.browser.viewport).toEqual({ width: 1920, height: 1080 });
    expect(config.safety.allow.delete).toBe(false);
    expect(config.safety.allow.payments).toBe(false);
    expect(config.recording.engine).toBe("cdp");
    expect(config.demo.default_resolution).toBe("1080p");
    expect(config.providers.ai.max_iterations).toBe(30);
  });

  it("defaults allowed domains to the base URL host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "df-"));
    const file = join(dir, "product.yaml");
    await writeFile(file, JSON.stringify(minimal));
    const config = await readProductConfig(file);
    expect(config.browser.allowed_domains).toEqual(["demo.acme.test"]);
  });

  it("reports every invalid field with its path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "df-"));
    const file = join(dir, "product.yaml");
    await writeFile(file, JSON.stringify({ ...minimal, product: { ...minimal.product, base_url: "not a url", id: "Bad Id" } }));
    const error = await readProductConfig(file).catch((e) => e);
    expect(error).toBeInstanceOf(DemoForgeError);
    expect(error.message).toContain("product.base_url");
    expect(error.message).toContain("product.id");
  });

  it("switching provider on the CLI drops the other provider's model", () => {
    const config = ProductConfigSchema.parse({ ...minimal, providers: { ...minimal.providers, ai: { provider: "anthropic", model: "claude-opus-5-5" } } });
    const switched = applyOverrides(config, { aiProvider: "openai" });
    expect(switched.providers.ai.provider).toBe("openai");
    expect(switched.providers.ai.model).toBeUndefined();
    expect(config.providers.ai.model).toBe("claude-opus-5-5"); // original untouched
    expect(applyOverrides(config, { aiProvider: "openai", aiModel: "gpt-5" }).providers.ai.model).toBe("gpt-5");
  });

  it("scaffolds a product that loads back and is listed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "df-"));
    await scaffoldProduct(dir, { id: "shop", name: "Shop", baseUrl: "http://localhost:3000", description: "A shop", aiProvider: "openai", ttsProvider: "elevenlabs" });
    const product = await loadProduct(dir, "shop");
    expect(product.config.providers.ai.provider).toBe("openai");
    expect(product.knowledge.map((k) => k.file)).toEqual(["overview.md"]);
    // Folders starting with `_` are not products.
    await mkdir(join(dir, "_drafts"));
    await writeFile(join(dir, "_drafts", "product.yaml"), JSON.stringify(minimal));
    const listed = await listProducts(dir);
    expect(listed).toEqual([expect.objectContaining({ id: "shop", valid: true })]);
    await expect(scaffoldProduct(dir, { id: "shop", name: "x", baseUrl: "http://x.test", description: "x", aiProvider: "openai", ttsProvider: "openai" })).rejects.toThrow(/already exists/);
  });

  it("loads the product's own .env without overriding values already set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "df-"));
    await mkdir(join(dir, "acme"));
    await writeFile(join(dir, "acme", "product.yaml"), JSON.stringify(minimal));
    await writeFile(join(dir, "acme", ".env"), "DF_TEST_USER=from-product\nDF_TEST_PASS='p@ss word'\n");
    process.env.DF_TEST_USER = "from-shell";
    delete process.env.DF_TEST_PASS;
    try {
      await loadProduct(dir, "acme");
      expect(process.env.DF_TEST_USER).toBe("from-shell");
      expect(process.env.DF_TEST_PASS).toBe("p@ss word");
    } finally {
      delete process.env.DF_TEST_USER;
      delete process.env.DF_TEST_PASS;
    }
  });

  it("requires the folder name to match product.id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "df-"));
    await mkdir(join(dir, "other"));
    await writeFile(join(dir, "other", "product.yaml"), JSON.stringify(minimal));
    await expect(loadProduct(dir, "other")).rejects.toThrow(/must match/);
  });

  it("keeps the examples in products/README.md valid", async () => {
    const { readFile } = await import("node:fs/promises");
    const { parse } = await import("yaml");
    const { parseFeatures, parseWorkflow } = await import("@demoforge/products");
    const readme = await readFile("products/README.md", "utf8");
    const blocks = [...readme.matchAll(/```(yaml|markdown)\r?\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1], text: m[2] as string }));
    const product = blocks.find((b) => b.lang === "yaml" && b.text.startsWith("version: 1"));
    const scenario = blocks.find((b) => b.lang === "yaml" && b.text.startsWith("workflow_version: 1"));
    const features = blocks.find((b) => b.lang === "markdown");

    const config = ProductConfigSchema.safeParse(parse(product!.text));
    expect(config.success, config.error?.message).toBe(true);
    // The reference claims to list the defaults, so it must match a minimal config's defaults.
    const bare = ProductConfigSchema.parse({ ...minimal, providers: { ai: { provider: "anthropic" } } });
    expect({ ...config.data!, product: null }).toEqual({ ...bare, product: null });
    expect(parseWorkflow(scenario!.text).steps).toHaveLength(5);
    expect(parseFeatures(features!.text).features.map((f) => f.title)).toEqual(["Bulk export", "Dark mode"]);
  });

  it("loads the bundled example product with its adapter and scenario", async () => {
    const product = await loadProduct("products", "example");
    expect(product.scenarios).toContain("create-project");
    expect(typeof product.adapter.setup).toBe("function");
  });
});

describe("workflow contract", () => {
  const base = { workflow_version: 1, id: "w", title: "T", objective: "O" };

  it("rejects actions without the data they need", () => {
    const result = WorkflowSchema.safeParse({
      ...base,
      steps: [
        { id: "a", description: "x", action: "click" },
        { id: "b", description: "x", action: "assert" },
        { id: "c", description: "x", action: "fill", target: { label: "Name" } },
      ],
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["steps.0.target", "steps.1.expected", "steps.2.value"]));
  });

  it("rejects an empty target", () => {
    const result = WorkflowSchema.safeParse({ ...base, steps: [{ id: "a", description: "x", action: "click", target: {} }] });
    expect(result.success).toBe(false);
  });

  it("defaults scenarios to unapproved", () => {
    const w = WorkflowSchema.parse({ ...base, steps: [{ id: "a", description: "x", action: "navigate", url: "/" }] });
    expect(w.approved).toBe(false);
    expect(w.setup).toEqual([]);
  });
});
