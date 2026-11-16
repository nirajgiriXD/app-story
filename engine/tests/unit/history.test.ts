import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJob, finishJob, readHistory } from "@demoforge/core";

const job = (outputDir: string, productId: string, name: string) =>
  createJob({ outputDir, productId, name, mode: "scenario", objective: null, scenarioId: name, logLevel: "silent" });

describe("job history", () => {
  it("lists finished jobs from their metadata, newest first, without an index file", async () => {
    const out = await mkdtemp(join(tmpdir(), "df-history-"));
    const first = await job(out, "shop", "checkout");
    await finishJob(first, "success");
    await new Promise((r) => setTimeout(r, 5)); // distinct created_at
    const second = await job(out, "crm", "contacts");
    await finishJob(second, "failed");
    await job(out, "shop", "still-running"); // never finished

    const all = await readHistory(out);
    expect(all.map((e) => [e.product_id, e.scenario_id, e.status])).toEqual([
      ["crm", "contacts", "failed"],
      ["shop", "checkout", "success"],
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
