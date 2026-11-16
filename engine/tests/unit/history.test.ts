import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  countPlans,
  createJob,
  deliverVideo,
  finishJob,
  forgetPlan,
  loadSavedPlan,
  planFile,
  readHistory,
  saveRecord,
  savePlan,
  storeFor,
} from "@app-story/core";
import { loadProduct, parseWorkflow } from "@app-story/products";
import { readFile } from "node:fs/promises";

const job = (outputDir: string, productId: string, name: string) =>
  createJob({ outputDir, productId, name, mode: "guided", objective: `show ${name}`, scenarioId: null, logLevel: "silent" });

/** A temporary workspace: <root>/output for videos, <root>/.app-story for the database. */
const workspace = async () => join(await mkdtemp(join(tmpdir(), "df-store-")), "output");

describe("job history in SQLite", () => {
  it("lists finished jobs newest first, from the database", async () => {
    const out = await workspace();
    const first = await job(out, "shop", "checkout");
    await finishJob(first, "success");
    await new Promise((r) => setTimeout(r, 5)); // distinct created_at
    const second = await job(out, "crm", "contacts");
    await finishJob(second, "failed");
    await job(out, "shop", "still-running"); // never finished

    const all = await readHistory(out);
    expect(all.map((e) => [e.product_id, e.objective, e.status])).toEqual([
      ["crm", "show contacts", "failed"],
      ["shop", "show checkout", "success"],
    ]);
    expect((await readHistory(out, { productId: "shop" })).map((e) => e.job_id)).toEqual([first.id]);
    expect(await readHistory(out, { limit: 1 })).toHaveLength(1);
    expect(existsSync(join(dirname(out), ".app-story", "app-story.db"))).toBe(true);
  });

  it("keeps a job's records, log and thumbnail in the database, with secrets scrubbed", async () => {
    const out = await workspace();
    const j = await job(out, "shop", "checkout");
    saveRecord(j, "quality", { passed: true, checks: [] });
    saveRecord(j, "captions_srt", "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
    saveRecord(j, "thumbnail", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    j.log.info("hello from the job");
    await finishJob(j, "success");

    const store = storeFor(out);
    expect(store.getRecordJson(j.id, "quality")).toEqual({ passed: true, checks: [] });
    expect(store.getRecordText(j.id, "captions_srt")).toContain("Hello");
    expect(store.getRecordBlob(j.id, "thumbnail")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(store.getRecordText(j.id, "log")).toContain("hello from the job");
    expect(store.getJob(j.id)?.status).toBe("success");
  });

  it("leaves only the video in output/, and deletes the scratch folder of a successful job", async () => {
    const out = await workspace();
    const ok = await job(out, "shop", "bulk-export");
    await mkdir(ok.paths.videoDir, { recursive: true });
    await writeFile(ok.paths.finalVideo, "fake video");
    ok.metadata.video = { path: ok.paths.finalVideo, thumbnail: null, duration_s: 1 };
    const delivered = await deliverVideo(ok);
    await finishJob(ok, "success");

    expect(delivered).toBe(join(out, "shop", `${ok.id}-bulk-export.mp4`));
    expect(await readdir(out)).toEqual(["shop"]);
    expect(await readdir(join(out, "shop"))).toEqual([`${ok.id}-bulk-export.mp4`]);
    expect(existsSync(ok.paths.root)).toBe(false);
    expect(storeFor(out).getJob(ok.id)?.video?.path).toBe(delivered);

    // A failed job keeps its scratch files for troubleshooting.
    const failed = await job(out, "shop", "broken");
    await finishJob(failed, "workflow_failure");
    expect(existsSync(failed.paths.root)).toBe(true);
  });

  it("returns nothing when there is no database yet", async () => {
    expect(await readHistory(await workspace())).toEqual([]);
  });
});

describe("saved plans", () => {
  /** A workspace with one product file, and the store next to it. */
  const productWorkspace = async () => {
    const root = await mkdtemp(join(tmpdir(), "df-plans-"));
    await mkdir(join(root, "products"));
    await writeFile(join(root, "products", "example.md"), "---\nurl: http://localhost:4310\n---\n# Example\n");
    return { product: await loadProduct(join(root, "products"), "example"), store: storeFor(join(root, "output")), root };
  };
  const fixture = async () => parseWorkflow(await readFile("engine/tests/fixtures/create-project.plan.yaml", "utf8"));

  it("are YAML files next to the product file, reused only for the same objective", async () => {
    const { product, store, root } = await productWorkspace();
    const plan = await fixture();

    expect(await loadSavedPlan(store, product, "Create a project!", plan.objective)).toBeUndefined(); // nothing saved yet
    const file = await savePlan(product, "Create a project!", plan);
    expect(file).toBe(join(root, "products", "example.plans", "create-a-project.yaml"));
    expect(await readFile(file, "utf8")).toMatch(/^# A verified click-plan/);
    expect(await countPlans(product)).toBe(1);
    expect((await loadSavedPlan(store, product, "create-a-project", plan.objective))?.steps).toEqual(plan.steps);
    // Edited release notes give a different objective: plan again.
    expect(await loadSavedPlan(store, product, "create-a-project", `${plan.objective} (now with tags)`)).toBeUndefined();

    await forgetPlan(product, "create-a-project");
    expect(await countPlans(product)).toBe(0);
  });

  it("says which file is broken instead of planning again silently", async () => {
    const { product, store } = await productWorkspace();
    const plan = await fixture();
    const file = await savePlan(product, "create-a-project", plan);
    await writeFile(file, "steps: [oops");
    await expect(loadSavedPlan(store, product, "create-a-project", plan.objective)).rejects.toThrow(/create-a-project\.yaml/);
  });

  it("moves a plan saved in the database by an older version to its file", async () => {
    const { product, store } = await productWorkspace();
    const plan = await fixture();
    const db = new DatabaseSync(store.file);
    db.prepare("INSERT INTO plans (product_id, key, objective, workflow, saved_at) VALUES (?, ?, ?, ?, ?)").run(
      "example",
      "create-a-project",
      plan.objective,
      JSON.stringify(plan),
      new Date().toISOString(),
    );
    db.close();

    expect((await loadSavedPlan(store, product, "create-a-project", plan.objective))?.steps).toEqual(plan.steps);
    expect(existsSync(planFile(product, "create-a-project"))).toBe(true);
    expect(store.takeLegacyPlan("example", "create-a-project")).toBeUndefined();
  });
});
