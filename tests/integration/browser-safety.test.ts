import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverProduct, withBrowser } from "@demoforge/core";
import { loadProduct } from "@demoforge/products";
import { createSilentLogger, isDemoForgeError } from "@demoforge/shared";
import { startExampleApp } from "../support/example-app";
import { ScriptedProvider } from "../support/fakes";

const PORT = 4393;
let app: { url: string; stop: () => void };
let productsDir: string;
let outputDir: string;
const log = createSilentLogger();

beforeAll(async () => {
  app = await startExampleApp(PORT);
  const root = await mkdtemp(join(tmpdir(), "demoforge-safety-"));
  productsDir = join(root, "products");
  outputDir = join(root, "output");
  await cp("products/example", join(productsDir, "example"), { recursive: true });
  const file = join(productsDir, "example", "product.yaml");
  await writeFile(file, (await readFile(file, "utf8")).replaceAll("4310", String(PORT)));
  process.env.EXAMPLE_APP_USER ??= "demo@example.com";
  process.env.EXAMPLE_APP_PASSWORD ??= "demo1234";
});

afterAll(() => app?.stop());

const T = (o: Record<string, unknown>) => ({ role: null, name: null, label: null, text: null, placeholder: null, test_id: null, css: null, nth: null, ...o });

describe("browser safety in a real Chromium", () => {
  it("blocks destructive clicks and off-domain navigation, even when asked to", async () => {
    const product = await loadProduct(productsDir, "example");
    await withBrowser(product, { phase: "dry_run", workDir: join(outputDir, "b1"), log }, async (session) => {
      const c = session.controller;
      await c.navigate("/settings");
      const blocked = await c.click({ role: "button", name: "Delete workspace" }).catch((e) => e);
      expect(isDemoForgeError(blocked) && blocked.code).toBe("POLICY_VIOLATION");

      const invite = await c.navigate("/team").then(() => c.click({ role: "button", name: "Invite member" })).catch((e) => e);
      expect(isDemoForgeError(invite) && invite.code).toBe("POLICY_VIOLATION");

      const offsite = await c.navigate("https://example.org/").catch((e) => e);
      expect(isDemoForgeError(offsite) && offsite.code).toBe("POLICY_VIOLATION");

      // Links the page itself points off-domain are blocked by the network guard too.
      await session.page.evaluate(() => {
        window.location.href = "https://example.org/";
      });
      await session.page.waitForTimeout(500);
      expect(session.page.url()).not.toContain("example.org");
      expect(c.issues.some((i) => i.kind === "blocked_navigation")).toBe(true);
    });
  });

  it("logs in with the form strategy and reports wrong credentials as an auth failure", async () => {
    const product = await loadProduct(productsDir, "example");
    const previous = process.env.EXAMPLE_APP_PASSWORD;
    process.env.EXAMPLE_APP_PASSWORD = "wrong-password";
    try {
      const error = await withBrowser(product, { phase: "dry_run", workDir: join(outputDir, "b2"), log }, async () => "unreachable").catch((e) => e);
      expect(isDemoForgeError(error) && error.code).toBe("AUTH_FAILED");
    } finally {
      process.env.EXAMPLE_APP_PASSWORD = previous;
    }
  });

  it("discovery explores read-only and cannot type or submit", async () => {
    const product = await loadProduct(productsDir, "example");
    const provider = new ScriptedProvider(
      [
        { name: "click", input: { target: T({ role: "link", name: "Team" }) } },
        { name: "note", input: { area: "Team", observation: "Lists team members." } },
        { name: "navigate", input: { url: "/projects/new" } },
        { name: "click", input: { target: T({ role: "button", name: "Create project" }) } },
        { name: "finish_discovery", input: { summary: "A project tracker." } },
      ],
      {
        discovery_report: {
          overview: "A project tracker.",
          navigation: [{ label: "Team", path: "/team" }],
          features: [],
          journeys: [],
          proposed_scenarios: [{ id: "create-project", title: "Create a project", objective: "Create a project", audience: "New users", estimated_duration_s: 60 }],
          missing_information: [],
          recommended_test_data: [],
        },
      },
    );
    const result = await discoverProduct({ product, outputDir, logLevel: "silent", providers: { createAI: () => provider } });
    expect(result.metadata.status).toBe("success");
    expect(result.report?.proposed_scenarios).toHaveLength(1);
    const results = provider.received.flatMap((r) => (r.type === "tool_results" ? r.results : []));
    const submit = results[3];
    expect(submit?.isError).toBe(true);
    expect(submit?.content).toMatch(/POLICY_VIOLATION/);
    const md = await readFile(result.reportFile!, "utf8");
    expect(md).toContain("--save-scenario");
  });
});
