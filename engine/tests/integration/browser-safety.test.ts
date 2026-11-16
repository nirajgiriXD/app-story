import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBrowser } from "@app-story/core";
import { loadProduct } from "@app-story/products";
import { createSilentLogger, isAppStoryError } from "@app-story/shared";
import { startExampleApp } from "../support/example-app";

const PORT = 4393;
let app: { url: string; stop: () => void };
let productsDir: string;
let outputDir: string;
const log = createSilentLogger();

beforeAll(async () => {
  app = await startExampleApp(PORT);
  const root = await mkdtemp(join(tmpdir(), "app-story-safety-"));
  productsDir = join(root, "products");
  outputDir = join(root, "output");
  await mkdir(productsDir);
  const text = (await readFile("products/example.md", "utf8")).replaceAll("4310", String(PORT));
  await writeFile(join(productsDir, "example.md"), text);
});

afterAll(() => app?.stop());

describe("browser safety in a real Chromium", () => {
  it("blocks destructive clicks and off-domain navigation, even when asked to", async () => {
    const product = await loadProduct(productsDir, "example");
    await withBrowser(product, { workDir: join(outputDir, "b1"), log }, async (session) => {
      const c = session.controller;
      await c.navigate("/settings");
      const blocked = await c.click({ role: "button", name: "Delete workspace" }).catch((e) => e);
      expect(isAppStoryError(blocked) && blocked.code).toBe("POLICY_VIOLATION");

      const invite = await c
        .navigate("/team")
        .then(() => c.click({ role: "button", name: "Invite member" }))
        .catch((e) => e);
      expect(isAppStoryError(invite) && invite.code).toBe("POLICY_VIOLATION");

      const offsite = await c.navigate("https://example.org/").catch((e) => e);
      expect(isAppStoryError(offsite) && offsite.code).toBe("POLICY_VIOLATION");

      // Links the page itself points off-domain are blocked by the network guard too.
      await session.page.evaluate(() => {
        window.location.href = "https://example.org/";
      });
      await session.page.waitForTimeout(500);
      expect(session.page.url()).not.toContain("example.org");
      expect(c.issues.some((i) => i.kind === "blocked_navigation")).toBe(true);
    });
  });

  it("finds the login form by itself, and reports a wrong password as an auth failure", async () => {
    const product = await loadProduct(productsDir, "example");
    // The right login lands on the start page.
    await withBrowser(product, { workDir: join(outputDir, "b2"), log }, async (session) => {
      expect(session.page.url()).toContain("/projects");
    });
    if (product.config.authentication.strategy !== "auto") throw new Error("expected a login");
    product.config.authentication.password = "wrong-password";
    const error = await withBrowser(product, { workDir: join(outputDir, "b3"), log }, async () => "unreachable").catch((e) => e);
    expect(isAppStoryError(error) && error.code).toBe("AUTH_FAILED");
  });

  it("read-only mode cannot type or submit", async () => {
    const product = await loadProduct(productsDir, "example");
    await withBrowser(product, { workDir: join(outputDir, "b4"), log, mode: "read_only" }, async (session) => {
      const c = session.controller;
      await c.navigate("/projects/new");
      const typed = await c.fill({ label: "Project name" }, "Should not be typed").catch((e) => e);
      expect(isAppStoryError(typed) && typed.code).toBe("POLICY_VIOLATION");
      const submitted = await c.click({ role: "button", name: "Create project" }).catch((e) => e);
      expect(isAppStoryError(submitted) && submitted.code).toBe("POLICY_VIOLATION");
    });
  });
});
