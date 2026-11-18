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
let appsDir: string;
let outputDir: string;
const log = createSilentLogger();

beforeAll(async () => {
  app = await startExampleApp(PORT);
  const root = await mkdtemp(join(tmpdir(), "app-story-safety-"));
  appsDir = join(root, "apps");
  outputDir = join(root, "output");
  await mkdir(appsDir);
  const text = (await readFile("apps/example.md", "utf8")).replaceAll("4310", String(PORT));
  await writeFile(join(appsDir, "example.md"), text);
});

afterAll(() => app?.stop());

describe("browser safety in a real Chromium", () => {
  it("blocks destructive clicks and off-domain navigation, even when asked to", async () => {
    const product = await loadProduct(appsDir, "example");
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
    const product = await loadProduct(appsDir, "example");
    // The right login lands on the start page.
    await withBrowser(product, { workDir: join(outputDir, "b2"), log }, async (session) => {
      expect(session.page.url()).toContain("/projects");
    });
    if (product.config.authentication.strategy !== "auto") throw new Error("expected a login");
    product.config.authentication.password = "wrong-password";
    const error = await withBrowser(product, { workDir: join(outputDir, "b3"), log }, async () => "unreachable").catch((e) => e);
    expect(isAppStoryError(error) && error.code).toBe("AUTH_FAILED");
  });

  it("blurs what the product file says to blur, on every page, and rejects a broken selector", async () => {
    const product = await loadProduct(appsDir, "example");
    product.config.browser.blur = [".sub", "td:nth-child(3)"];
    await withBrowser(product, { workDir: join(outputDir, "b5"), log }, async (session) => {
      const filterOf = (selector: string) =>
        session.page
          .locator(selector)
          .first()
          .evaluate((el) => getComputedStyle(el).filter);
      expect(await filterOf(".sub")).toBe("blur(10px)");
      expect(await filterOf("td:nth-child(3)")).toBe("blur(10px)");
      expect(await filterOf("h1")).toBe("none");
      // A new document (a full page load) is blurred too.
      await session.controller.navigate("/projects/new");
      expect(await filterOf(".sub")).toBe("blur(10px)");
    });
    product.config.browser.blur = ["td:nth-child("];
    const error = await withBrowser(product, { workDir: join(outputDir, "b6"), log }, async () => "unreachable").catch((e) => e);
    expect(isAppStoryError(error) && error.code).toBe("CONFIG_INVALID");
  });

  it("read-only mode cannot type or submit", async () => {
    const product = await loadProduct(appsDir, "example");
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
