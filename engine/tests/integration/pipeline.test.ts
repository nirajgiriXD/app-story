import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Workflow } from "@app-story/contracts";
import { generateDemo, listTakes, planFile, redoVideo, replayPlans, resumeDemo, savePlan, storeFor } from "@app-story/core";
import { loadProduct, parseWorkflow } from "@app-story/products";
import { AppStoryError, probeMedia } from "@app-story/shared";
import { startExampleApp } from "../support/example-app";
import { ScriptedProvider, ToneTTS } from "../support/fakes";

const PORT = 4391;
let app: { url: string; stop: () => void };
let productsDir: string;
let outputDir: string;
let root: string;
let plan: Workflow;

beforeAll(async () => {
  // The AI review of the finished video would make a real, paid call: it has its own unit tests.
  process.env.APP_STORY_AI_REVIEW = "off";
  app = await startExampleApp(PORT);
  root = await mkdtemp(join(tmpdir(), "app-story-it-"));
  productsDir = join(root, "products");
  outputDir = join(root, "output");
  await mkdir(productsDir);
  // The practice product, pointed at this test's app instance.
  const text = (await readFile("products/example.md", "utf8")).replaceAll("4310", String(PORT));
  await writeFile(join(productsDir, "example.md"), text);
  plan = parseWorkflow(await readFile("engine/tests/fixtures/create-project.plan.yaml", "utf8"));
});

afterAll(() => app?.stop());

/** The practice product in a folder of its own, so saved plans of one test never meet another's. */
async function productIn(folder: string) {
  const dir = join(root, folder, "products");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "example.md"), await readFile(join(productsDir, "example.md"), "utf8"));
  return { product: await loadProduct(dir, "example"), out: join(root, folder, "output") };
}

const T = (o: Record<string, unknown>) => ({ role: null, name: null, label: null, text: null, placeholder: null, test_id: null, css: null, nth: null, ...o });

/** A scripted AI that plans "create a project" (with one wrong guess it must recover from). */
const plannerAI = () =>
  new ScriptedProvider(
    [
      {
        name: "click",
        input: { description: "Open the new project form", section: "Create", target: T({ role: "link", name: "+ New project" }), expected: null },
      },
      { name: "click", input: { description: "Open settings", section: "Create", target: T({ role: "button", name: "Does not exist" }), expected: null } },
      {
        name: "fill",
        input: {
          description: "Name the project",
          section: "Create",
          target: T({ label: "Project name" }),
          value: "Website Launch",
          secret: null,
          expected: null,
        },
      },
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

describe("end-to-end pipeline (real browser, login, recorder and renderer)", () => {
  it("logs in by itself and renders a plan into a playable 1080p MP4 with captions and a report", async () => {
    const product = await loadProduct(productsDir, "example");
    const tts = new ToneTTS();
    const metadata = await generateDemo({ product, outputDir, objective: OBJECTIVE, plan, logLevel: "warn", providers: { createTTS: () => tts } });

    expect(metadata.errors).toEqual([]);
    expect(["success", "success_with_warnings"]).toContain(metadata.status);
    const video = await probeMedia(metadata.video!.path);
    expect([video.width, video.height, video.videoCodec, video.audioCodec]).toEqual([1920, 1080, "h264", "aac"]);
    expect(video.durationSec).toBeGreaterThan(15);

    // Everything but the video is in the database.
    const store = storeFor(outputDir);
    const quality = store.getRecordJson<{ checks: { passed: boolean; severity: string }[] }>(metadata.job_id, "quality");
    expect(quality?.checks.filter((c) => !c.passed && c.severity === "error")).toEqual([]);
    expect(store.getRecordText(metadata.job_id, "captions_srt")).toContain("Q3 Product Launch");
    expect(store.getRecordBlob(metadata.job_id, "thumbnail")?.subarray(1, 4).toString()).toBe("PNG");
    expect(store.getRecordJson(metadata.job_id, "plan")).toMatchObject({ id: "create-project" });
    expect(store.getRecordText(metadata.job_id, "log")).toBeTruthy();
    expect(tts.calls.length).toBe(9); // intro + 7 segments + outro

    // output/ holds only the video and its captions, and the scratch folder is gone.
    expect(metadata.video!.path).toBe(join(outputDir, "example", `${metadata.job_id}-${"demonstrate-how-to-create-a-new-project"}.mp4`));
    expect((await readdir(join(outputDir, "example"))).sort()).toEqual([
      basename(metadata.video!.path),
      basename(metadata.video!.path).replace(/\.mp4$/, ".srt"),
    ]);
    expect(existsSync(metadata.output_dir)).toBe(false);
  });

  it("makes a video again from its kept recording, in another look, without the app", async () => {
    const product = await loadProduct(productsDir, "example");
    const [newest] = await listTakes(storeFor(outputDir).dataDir, "example");
    expect(newest).toBeDefined();
    // Pointed at an address where nothing runs: a redo never opens the app.
    const offline = { ...product, config: { ...product.config, product: { ...product.config.product, base_url: "http://127.0.0.1:9" } } };
    const metadata = await redoVideo({ product: offline, outputDir, template: "minimal", logLevel: "warn" });

    expect(metadata.errors).toEqual([]);
    expect(metadata.status).toBe("success");
    expect(metadata.mode).toBe("redo");
    expect(metadata.redo_of).toBe(newest?.jobId);
    const video = await probeMedia(metadata.video!.path);
    expect([video.width, video.height, video.videoCodec, video.audioCodec]).toEqual([1920, 1080, "h264", "aac"]);
    expect(storeFor(outputDir).getRecordJson(metadata.job_id, "config")).toMatchObject({ config: { demo: { template: "minimal" } } });
  });

  it("narrates with the free local Kokoro voice (no API key)", async () => {
    const product = await loadProduct(productsDir, "example", { ttsProvider: "kokoro" });
    const metadata = await generateDemo({ product, outputDir, objective: OBJECTIVE, plan, logLevel: "warn" });

    expect(metadata.errors).toEqual([]);
    expect(metadata.status).toBe("success");
    expect(metadata.tts.provider).toBe("kokoro");
    const quality = storeFor(outputDir).getRecordJson<{ checks: { name: string; passed: boolean }[] }>(metadata.job_id, "quality");
    const silentCheck = quality?.checks.find((c) => c.name === "no silent narration segments");
    expect(silentCheck?.passed).toBe(true);
  }, 300_000);

  it("makes a captions-only video when there is no voice", async () => {
    const product = await loadProduct(productsDir, "example", { ttsProvider: "none" });
    const metadata = await generateDemo({ product, outputDir, objective: OBJECTIVE, plan, logLevel: "warn" });

    expect(metadata.errors).toEqual([]);
    expect(metadata.status).toBe("success");
    expect(metadata.tts.provider).toBe("none");
    expect(storeFor(outputDir).getRecordText(metadata.job_id, "captions_srt")).toContain("Q3 Product Launch");
  });

  it("plans with AI, saves the plan, then replays it next time without AI planning", async () => {
    const { product, out } = await productIn("replay");
    const ai = plannerAI();
    const providers = { createAI: (_config: unknown, deps: { usage: unknown }) => Object.assign(ai, { usage: deps.usage }), createTTS: () => new ToneTTS() };

    const first = await generateDemo({ product, outputDir: out, objective: OBJECTIVE, name: "create-project", logLevel: "warn", providers });
    expect(first.errors).toEqual([]);
    expect(first.mode).toBe("guided");
    const saved = parseWorkflow(await readFile(planFile(product, "create-project"), "utf8"));
    expect(saved.steps.map((s) => s.action)).toEqual(["click", "fill", "click", "assert"]);
    // The narration is saved with the plan, so a replay elsewhere needs no AI.
    expect(saved.narration).toMatchObject({ language: "en", intro: "Here is how to create a project." });
    const agentTurns = ai.received.length;

    const second = await generateDemo({ product, outputDir: out, objective: OBJECTIVE, name: "create-project", logLevel: "warn", providers });
    expect(second.errors).toEqual([]);
    expect(["success", "success_with_warnings"]).toContain(second.status);
    expect(second.mode).toBe("scenario"); // replayed the saved plan
    expect(ai.received.length).toBe(agentTurns); // no AI planning the second time
  });

  it("plans again by itself when a saved plan no longer matches the app", async () => {
    const { product, out } = await productIn("stale");
    // A saved plan for the same objective whose button no longer exists.
    const stale: Workflow = {
      ...plan,
      steps: [
        { id: "s1", description: "Open the old wizard", action: "click", target: { role: "button", name: "Old wizard" } },
        { id: "s2", description: "Check the list", action: "assert", expected: { type: "text_present", text: "Projects" } },
      ],
    };
    await savePlan(product, "create-project", { ...stale, objective: OBJECTIVE });

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
    const replaced = parseWorkflow(await readFile(planFile(product, "create-project"), "utf8"));
    expect(replaced.steps.some((s) => s.value === "Website Launch")).toBe(true);
  });

  it("replays saved plans with no AI at all, and leaves their files as they were", async () => {
    const { product, out } = await productIn("ci");
    const ai = plannerAI();
    const createTTS = () => new ToneTTS();
    await generateDemo({
      product,
      outputDir: out,
      objective: OBJECTIVE,
      name: "create-project",
      logLevel: "silent",
      providers: { createAI: (_config, deps) => Object.assign(ai, { usage: deps.usage }), createTTS },
    });
    const file = planFile(product, "create-project");
    const before = await readFile(file, "utf8");

    // A CI runner: no AI key. Any AI call fails the test.
    const noAI = () => {
      throw new Error("the AI must not be called");
    };
    const [replayed] = await replayPlans({ product, outputDir: out, logLevel: "silent", providers: { createAI: noAI, createTTS } });
    expect(replayed?.errors).toEqual([]);
    expect(["success", "success_with_warnings"]).toContain(replayed?.status);
    expect(replayed?.mode).toBe("scenario");
    expect(replayed?.ai.attempts).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("finishes a failed video from its plan, without asking the AI again", async () => {
    const { product, out } = await productIn("resume");
    const ai = plannerAI();
    const createAI = (_config: unknown, deps: { usage: unknown }) => Object.assign(ai, { usage: deps.usage });
    const brokenVoice = new ToneTTS();
    brokenVoice.synthesize = async () => {
      throw new AppStoryError("TTS_ERROR", "the voice service is down");
    };

    const failed = await generateDemo({
      product,
      outputDir: out,
      objective: OBJECTIVE,
      name: "create-project",
      logLevel: "silent",
      providers: { createAI, createTTS: () => brokenVoice },
    });
    expect(failed.status).not.toMatch(/success/);
    expect(existsSync(planFile(product, "create-project"))).toBe(false);
    const [agentTurns, structuredCalls] = [ai.received.length, ai.structuredPrompts.length];

    const resumed = await resumeDemo({ product, outputDir: out, logLevel: "warn", providers: { createAI, createTTS: () => new ToneTTS() } });
    expect(resumed.errors).toEqual([]);
    expect(["success", "success_with_warnings"]).toContain(resumed.status);
    expect(resumed.resumed_from).toBe(failed.job_id);
    expect([ai.received.length, ai.structuredPrompts.length]).toEqual([agentTurns, structuredCalls]); // no planning, script from the cache
    expect(resumed.video!.path).toMatch(/create-project\.mp4$/);
    expect(parseWorkflow(await readFile(planFile(product, "create-project"), "utf8")).steps.length).toBeGreaterThan(0);
  });
});
