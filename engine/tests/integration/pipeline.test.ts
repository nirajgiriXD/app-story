import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Workflow } from "@demoforge/contracts";
import { generateDemo } from "@demoforge/core";
import { loadProduct, parseWorkflow, workflowToYaml } from "@demoforge/products";
import { probeMedia } from "@demoforge/shared";
import { savedPlanFile } from "../../packages/core/src/pipeline/plans";
import { startExampleApp } from "../support/example-app";
import { ScriptedProvider, ToneTTS } from "../support/fakes";

const PORT = 4391;
let app: { url: string; stop: () => void };
let productsDir: string;
let outputDir: string;
let plan: Workflow;

beforeAll(async () => {
  app = await startExampleApp(PORT);
  const root = await mkdtemp(join(tmpdir(), "demoforge-it-"));
  productsDir = join(root, "products");
  outputDir = join(root, "output");
  await mkdir(productsDir);
  // The practice product, pointed at this test's app instance.
  const text = (await readFile("products/example.md", "utf8")).replaceAll("4310", String(PORT));
  await writeFile(join(productsDir, "example.md"), text);
  plan = parseWorkflow(await readFile("engine/tests/fixtures/create-project.plan.yaml", "utf8"));
});

afterAll(() => app?.stop());

const T = (o: Record<string, unknown>) => ({ role: null, name: null, label: null, text: null, placeholder: null, test_id: null, css: null, nth: null, ...o });

/** A scripted AI that plans "create a project" (with one wrong guess it must recover from). */
const plannerAI = () =>
  new ScriptedProvider(
    [
      { name: "click", input: { description: "Open the new project form", section: "Create", target: T({ role: "link", name: "+ New project" }), expected: null } },
      { name: "click", input: { description: "Open settings", section: "Create", target: T({ role: "button", name: "Does not exist" }), expected: null } },
      { name: "fill", input: { description: "Name the project", section: "Create", target: T({ label: "Project name" }), value: "Website Launch", secret: null, expected: null } },
      { name: "click", input: { description: "Save the project", section: "Create", target: T({ role: "button", name: "Create project" }), expected: null } },
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

const OBJECTIVE = "Demonstrate how to create a new project";

describe("end-to-end pipeline (real browser, login, recorder and Remotion)", () => {
  it("logs in by itself and renders a plan into a playable 1080p MP4 with captions and a report", async () => {
    const product = await loadProduct(productsDir, "example");
    const tts = new ToneTTS();
    const metadata = await generateDemo({ product, outputDir, objective: OBJECTIVE, plan, logLevel: "warn", providers: { createTTS: () => tts } });

    expect(metadata.errors).toEqual([]);
    expect(["success", "success_with_warnings"]).toContain(metadata.status);
    const video = await probeMedia(metadata.video!.path);
    expect([video.width, video.height, video.videoCodec, video.audioCodec]).toEqual([1920, 1080, "h264", "aac"]);
    expect(video.durationSec).toBeGreaterThan(15);

    const quality = JSON.parse(await readFile(join(metadata.output_dir, "quality.json"), "utf8"));
    const failedErrors = quality.checks.filter((c: { passed: boolean; severity: string }) => !c.passed && c.severity === "error");
    expect(failedErrors).toEqual([]);

    const srt = await readFile(join(metadata.output_dir, "captions", "subtitles.srt"), "utf8");
    expect(srt).toContain("Q3 Product Launch");
    expect(tts.calls.length).toBe(9); // intro + 7 segments + outro
  });

  it("narrates with the free local Kokoro voice (no API key)", async () => {
    const product = await loadProduct(productsDir, "example", { ttsProvider: "kokoro" });
    const metadata = await generateDemo({ product, outputDir, objective: OBJECTIVE, plan, logLevel: "warn" });

    expect(metadata.errors).toEqual([]);
    expect(metadata.status).toBe("success");
    expect(metadata.tts.provider).toBe("kokoro");
    const quality = JSON.parse(await readFile(join(metadata.output_dir, "quality.json"), "utf8"));
    const silentCheck = quality.checks.find((c: { name: string }) => c.name === "no silent narration segments");
    expect(silentCheck?.passed).toBe(true);
  }, 300_000);

  it("makes a captions-only video when there is no voice", async () => {
    const product = await loadProduct(productsDir, "example", { ttsProvider: "none" });
    const metadata = await generateDemo({ product, outputDir, objective: OBJECTIVE, plan, logLevel: "warn" });

    expect(metadata.errors).toEqual([]);
    expect(metadata.status).toBe("success");
    expect(metadata.tts.provider).toBe("none");
    const srt = await readFile(join(metadata.output_dir, "captions", "subtitles.srt"), "utf8");
    expect(srt).toContain("Q3 Product Launch");
  });

  it("plans with AI, saves the plan, then replays it next time without AI planning", async () => {
    const product = await loadProduct(productsDir, "example");
    const ai = plannerAI();
    const providers = { createAI: (_config: unknown, deps: { usage: unknown }) => Object.assign(ai, { usage: deps.usage }), createTTS: () => new ToneTTS() };
    const out = join(outputDir, "replay");

    const first = await generateDemo({ product, outputDir: out, objective: OBJECTIVE, name: "create-project", logLevel: "warn", providers });
    expect(first.errors).toEqual([]);
    expect(first.mode).toBe("guided");
    const saved = await readFile(savedPlanFile(out, "example", "create-project"), "utf8");
    expect(parseWorkflow(saved).steps.map((s) => s.action)).toEqual(["click", "fill", "click", "assert"]);
    const agentTurns = ai.received.length;

    const second = await generateDemo({ product, outputDir: out, objective: OBJECTIVE, name: "create-project", logLevel: "warn", providers });
    expect(second.errors).toEqual([]);
    expect(["success", "success_with_warnings"]).toContain(second.status);
    expect(second.mode).toBe("scenario"); // replayed the saved plan
    expect(ai.received.length).toBe(agentTurns); // no AI planning the second time
  });

  it("plans again by itself when a saved plan no longer matches the app", async () => {
    const product = await loadProduct(productsDir, "example");
    const out = join(outputDir, "stale");
    // A saved plan for the same objective whose button no longer exists.
    const stale: Workflow = {
      ...plan,
      steps: [
        { id: "s1", description: "Open the old wizard", action: "click", target: { role: "button", name: "Old wizard" } },
        { id: "s2", description: "Check the list", action: "assert", expected: { type: "text_present", text: "Projects" } },
      ],
    };
    const file = savedPlanFile(out, "example", "create-project");
    await mkdir(join(out, ".plans", "example"), { recursive: true });
    await writeFile(file, workflowToYaml({ ...stale, objective: OBJECTIVE }));

    const ai = plannerAI();
    const metadata = await generateDemo({
      product,
      outputDir: out,
      objective: OBJECTIVE,
      name: "create-project",
      logLevel: "silent",
      providers: { createAI: (_config, deps) => Object.assign(ai, { usage: deps.usage }), createTTS: () => new ToneTTS() },
    });
    expect(metadata.errors).toEqual([]);
    expect(metadata.status).toBe("success_with_warnings");
    expect(metadata.warnings.join()).toMatch(/planned again/);
    const replaced = parseWorkflow(await readFile(file, "utf8"));
    expect(replaced.steps.some((s) => s.value === "Website Launch")).toBe(true);
  });
});
