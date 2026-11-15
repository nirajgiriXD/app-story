import { mkdtemp, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDemo } from "@demoforge/core";
import { loadProduct } from "@demoforge/products";
import { probeMedia } from "@demoforge/shared";
import { startExampleApp } from "../support/example-app";
import { ScriptedProvider, ToneTTS } from "../support/fakes";

const PORT = 4391;
let app: { url: string; stop: () => void };
let productsDir: string;
let outputDir: string;

beforeAll(async () => {
  app = await startExampleApp(PORT);
  const root = await mkdtemp(join(tmpdir(), "demoforge-it-"));
  productsDir = join(root, "products");
  outputDir = join(root, "output");
  await cp("products/example", join(productsDir, "example"), { recursive: true });
  // Point the copied product at this test's app instance.
  const file = join(productsDir, "example", "product.yaml");
  const yaml = (await readFile(file, "utf8")).replaceAll("4310", String(PORT));
  await (await import("node:fs/promises")).writeFile(file, yaml);
  process.env.EXAMPLE_APP_USER ??= "demo@example.com";
  process.env.EXAMPLE_APP_PASSWORD ??= "demo1234";
});

afterAll(() => app?.stop());

describe("end-to-end pipeline (fake voice, real browser + recorder + Remotion)", () => {
  it("renders a verified scenario into a playable 1080p MP4 with captions and a report", async () => {
    const product = await loadProduct(productsDir, "example");
    const tts = new ToneTTS();
    const metadata = await generateDemo({
      product,
      outputDir,
      scenarioId: "create-project",
      logLevel: "warn",
      providers: { createTTS: () => tts },
    });

    expect(metadata.errors).toEqual([]);
    expect(["success", "success_with_warnings"]).toContain(metadata.status);
    expect(metadata.video?.path).toBeTruthy();

    const video = await probeMedia(metadata.video!.path);
    expect(video.width).toBe(1920);
    expect(video.height).toBe(1080);
    expect(video.videoCodec).toBe("h264");
    expect(video.audioCodec).toBe("aac");
    expect(video.durationSec).toBeGreaterThan(15);

    const quality = JSON.parse(await readFile(join(metadata.output_dir, "quality.json"), "utf8"));
    const failedErrors = quality.checks.filter((c: { passed: boolean; severity: string }) => !c.passed && c.severity === "error");
    expect(failedErrors).toEqual([]);

    const srt = await readFile(join(metadata.output_dir, "captions", "subtitles.srt"), "utf8");
    expect(srt).toContain("Q3 Product Launch");
    // intro + 7 segments + outro
    expect(tts.calls.length).toBe(9);
  });

  it("refuses to make a video from an unapproved scenario", async () => {
    const product = await loadProduct(productsDir, "example");
    const { saveScenario, loadScenario } = await import("@demoforge/products");
    const scenario = await loadScenario(product, "create-project");
    await saveScenario(product, { ...scenario, id: "draft", approved: false });
    const fresh = await loadProduct(productsDir, "example");
    const metadata = await generateDemo({ product: fresh, outputDir, scenarioId: "draft", logLevel: "silent", providers: { createTTS: () => new ToneTTS() } });
    expect(metadata.status).toBe("unsupported_workflow");
    expect(metadata.video).toBeNull();
    expect(metadata.errors[0]?.code).toBe("SCENARIO_NOT_APPROVED");
  });

  it("plans with an AI agent (scripted), then records the verified plan", async () => {
    const product = await loadProduct(productsDir, "example");
    const target = (o: Record<string, unknown>) => ({ role: null, name: null, label: null, text: null, placeholder: null, test_id: null, css: null, nth: null, ...o });
    const provider = new ScriptedProvider(
      [
        { name: "click", input: { description: "Open the new project form", section: "Create", target: target({ role: "link", name: "+ New project" }), expected: null } },
        // A deliberate wrong guess: the agent must recover, and the failed step must not be replayed.
        { name: "click", input: { description: "Open settings", section: "Create", target: target({ role: "button", name: "Does not exist" }), expected: null } },
        { name: "fill", input: { description: "Name the project", section: "Create", target: target({ label: "Project name" }), value: "Website Launch", secret: null, expected: null } },
        { name: "click", input: { description: "Save the project", section: "Create", target: target({ role: "button", name: "Create project" }), expected: null } },
        {
          name: "verify",
          input: {
            description: "The new project is listed",
            section: "Result",
            expectation: { type: "text_present", text: "Website Launch", target: null, value: null, count: null, description: "project appears in the list" },
          },
        },
        { name: "finish", input: { title: "Create a project", summary: "Create a project in seconds.", keep_step_ids: ["r1", "r3", "r4", "r5"] } },
      ],
      {
        narration_script: {
          intro: "Here is how to create a project.",
          segments: [
            { step_ids: ["s1", "s2"], text: "Open the form and give the project a name." },
            { step_ids: ["s3", "s4"], text: "Save it, and it appears in your list." },
          ],
          outro: "That's it.",
        },
      },
    );

    const metadata = await generateDemo({
      product,
      outputDir,
      objective: "Demonstrate how to create a new project",
      logLevel: "warn",
      providers: {
        createAI: (_config, deps) => Object.assign(provider, { usage: deps.usage }),
        createTTS: () => new ToneTTS(),
      },
    });

    expect(metadata.errors).toEqual([]);
    expect(["success", "success_with_warnings"]).toContain(metadata.status);
    const plan = JSON.parse(await readFile(join(metadata.output_dir, "plan.json"), "utf8"));
    expect(plan.steps.map((s: { action: string }) => s.action)).toEqual(["click", "fill", "click", "assert"]);
    expect(plan.approved).toBe(false);
    expect(metadata.ai.provider).toBe("anthropic");
    expect(metadata.usage?.requests).toBeGreaterThan(0);
  });
});
