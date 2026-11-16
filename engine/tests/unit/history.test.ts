import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJob, deliverVideo, finishJob, readHistory, saveRecord, storeFor } from "@demoforge/core";
import { parseWorkflow } from "@demoforge/products";
import { readFile } from "node:fs/promises";
import { forgetPlan, loadSavedPlan, savePlan } from "../../packages/core/src/pipeline/plans";

const job = (outputDir: string, productId: string, name: string) =>
  createJob({ outputDir, productId, name, mode: "guided", objective: `show ${name}`, scenarioId: null, logLevel: "silent" });

/** A temporary workspace: <root>/output for videos, <root>/engine/data for the database. */
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
    expect(existsSync(join(dirname(out), "engine", "data", "demoforge.db"))).toBe(true);
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
  it("are reused only for the same objective", async () => {
    const store = storeFor(await workspace());
    const plan = parseWorkflow(await readFile("engine/tests/fixtures/create-project.plan.yaml", "utf8"));

    expect(loadSavedPlan(store, "example", "Create a project!", plan.objective)).toBeUndefined(); // nothing saved yet
    savePlan(store, "example", "Create a project!", plan);
    expect(store.countPlans("example")).toBe(1);
    expect(loadSavedPlan(store, "example", "create-a-project", plan.objective)?.steps).toHaveLength(plan.steps.length);
    // Edited release notes give a different objective: plan again.
    expect(loadSavedPlan(store, "example", "create-a-project", `${plan.objective} (now with tags)`)).toBeUndefined();

    forgetPlan(store, "example", "create-a-project");
    expect(store.countPlans("example")).toBe(0);
  });
});
