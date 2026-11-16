import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJob, finishJob, readHistory } from "@demoforge/core";
import { parseWorkflow } from "@demoforge/products";
import { forgetPlan, loadSavedPlan, savePlan, savedPlanFile } from "../../packages/core/src/pipeline/plans";

const job = (outputDir: string, productId: string, name: string) =>
  createJob({ outputDir, productId, name, mode: "guided", objective: `show ${name}`, scenarioId: null, logLevel: "silent" });

describe("job history", () => {
  it("lists finished jobs from their metadata, newest first, without an index file", async () => {
    const out = await mkdtemp(join(tmpdir(), "df-history-"));
    const first = await job(out, "shop", "checkout");
    await finishJob(first, "success");
    await new Promise((r) => setTimeout(r, 5)); // distinct created_at
    const second = await job(out, "crm", "contacts");
    await finishJob(second, "failed");
    await job(out, "shop", "still-running"); // never finished
    // Saved plans live next to the jobs but are not jobs.
    await mkdir(join(out, ".plans", "shop"), { recursive: true });

    // One folder per job: output/<product>/<job-id>-<name>/
    expect(dirname(first.paths.root)).toBe(join(out, "shop"));
    expect(basename(first.paths.root)).toBe(`${first.id}-checkout`);

    const all = await readHistory(out);
    expect(all.map((e) => [e.product_id, e.objective, e.status])).toEqual([
      ["crm", "show contacts", "failed"],
      ["shop", "show checkout", "success"],
    ]);
    expect((await readHistory(out, { productId: "shop" })).map((e) => e.job_id)).toEqual([first.id]);
    expect(await readHistory(out, { limit: 1 })).toHaveLength(1);
    expect(await readdir(out)).not.toContain("history.jsonl");

    // Deleting a job folder removes it from the history.
    await rm(second.paths.root, { recursive: true, force: true });
    expect((await readHistory(out)).map((e) => e.job_id)).toEqual([first.id]);
  });

  it("returns nothing when the output folder does not exist", async () => {
    expect(await readHistory(join(tmpdir(), "df-history-missing-folder"))).toEqual([]);
  });
});

describe("saved plans", () => {
  it("are reused only for the same objective, and a damaged file is ignored", async () => {
    const out = await mkdtemp(join(tmpdir(), "df-plans-"));
    const plan = parseWorkflow(await readFile("engine/tests/fixtures/create-project.plan.yaml", "utf8"));
    const file = savedPlanFile(out, "example", "Create a project!");
    expect(file).toBe(join(out, ".plans", "example", "create-a-project.yaml"));

    expect(await loadSavedPlan(file, plan.objective)).toBeUndefined(); // nothing saved yet
    await savePlan(file, plan);
    expect((await loadSavedPlan(file, plan.objective))?.steps).toHaveLength(plan.steps.length);
    // Edited release notes give a different objective: plan again.
    expect(await loadSavedPlan(file, `${plan.objective} (now with tags)`)).toBeUndefined();

    await writeFile(file, "steps: [ not valid");
    expect(await loadSavedPlan(file, plan.objective)).toBeUndefined();
    await forgetPlan(file);
    await expect(readFile(file)).rejects.toThrow();
  });
});
