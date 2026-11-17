import { describe, expect, it } from "vitest";
import { serialQueue, sleep } from "@app-story/shared";

describe("serialQueue", () => {
  it("runs one task at a time, in order", async () => {
    const queue = serialQueue();
    const events: string[] = [];
    const task = (name: string, ms: number) =>
      queue(async () => {
        events.push(`start ${name}`);
        await sleep(ms);
        events.push(`end ${name}`);
        return name;
      });
    expect(await Promise.all([task("a", 20), task("b", 1), task("c", 5)])).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("keeps going after a failed task, and gives the error only to its caller", async () => {
    const queue = serialQueue();
    const failed = queue(async () => {
      throw new Error("boom");
    });
    const next = queue(async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("ok");
  });
});
