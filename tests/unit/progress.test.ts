import { describe, expect, it } from "vitest";
import { ProgressView } from "../../cli/src/progress";

const rec = (fields: Record<string, unknown>, msg: string, level = 30) => ({ level, msg, time: 0, ...fields });
const job = (id: string, video: string) => ({ job: id, video });

describe("live progress", () => {
  it("shows one line per running task, updated in place, frozen with its time when it ends", () => {
    const view = new ProgressView();
    view.handle(rec({ ...job("j1", "create-project"), stage: "plan" }, "Plan"), 0);
    view.handle(rec(job("j1", "create-project"), "replaying the saved plan"), 100);
    let frame = view.frame(12_000, 120);
    expect(frame.done).toEqual([]);
    expect(frame.live).toHaveLength(1);
    expect(frame.live[0]).toMatch(/^\S \s*0:12 Plan · create-project: replaying the saved plan$/);

    // The next stage ends this one: it is printed once, with how long it took.
    view.handle(rec({ ...job("j1", "create-project"), stage: "recording" }, "Recording"), 12_300);
    view.handle(rec(job("j1", "create-project"), '✓ Click "Save"'), 13_000);
    frame = view.frame(14_000, 120);
    expect(frame.done).toEqual(["✔  12.3s Plan · create-project: replaying the saved plan"]);
    expect(frame.live[0]).toContain('Recording · create-project: ✓ Click "Save"');
    expect(view.frame(14_100, 120).done).toEqual([]); // printed only once

    view.handle(rec({ ...job("j1", "create-project"), stage: "end", ok: false, error: "Step s3 failed" }, "failed"), 75_000);
    frame = view.frame(75_000, 120);
    expect(frame.done).toEqual(["✖ 1m 03s Recording · create-project: Step s3 failed"]);
    expect(frame.live).toEqual([]);
  });

  it("gives each video made at once a line of its own, and keeps warnings above them", () => {
    const view = new ProgressView();
    view.handle(rec({ ...job("j1", "export"), stage: "render" }, "Render"), 0);
    view.handle(rec({ ...job("j2", "search"), stage: "plan" }, "Plan"), 0);
    view.handle(rec(job("j1", "export"), "rendering video 40%"), 0);
    view.handle(rec({ ...job("j2", "search"), error: "timeout" }, "AI review failed", 40), 0);
    const frame = view.frame(1000, 120);
    expect(frame.live.map((l) => l.replace(/^\S \s*\S+ /, ""))).toEqual(["Render · export: rendering video 40%", "Plan · search"]);
    expect(frame.done).toEqual(["  ! search: AI review failed (timeout)"]);
  });

  it("keeps each video on its own row from stage to stage", () => {
    const view = new ProgressView();
    view.handle(rec({ ...job("j1", "export"), stage: "plan" }, "Plan"), 0);
    view.handle(rec({ ...job("j2", "search"), stage: "plan" }, "Plan"), 0);
    view.handle(rec({ ...job("j1", "export"), stage: "narration" }, "Narration"), 500);
    const videos = view.frame(1000, 120).live.map((l) => /· (\S+)/.exec(l)?.[1]);
    expect(videos).toEqual(["export", "search"]);
  });

  it("cuts a long status to the terminal's width, so a line never wraps", () => {
    const view = new ProgressView();
    view.handle(rec({ ...job("j1", "v"), stage: "plan" }, "Plan"), 0);
    view.handle(rec(job("j1", "v"), "x".repeat(300)), 0);
    const [line] = view.frame(0, 60).live;
    expect(line?.length).toBeLessThanOrEqual(60);
    expect(line?.endsWith("…")).toBe(true);
  });

  it("ends what is still running when the command is over", () => {
    const view = new ProgressView();
    view.handle(rec({}, "checking the login"), 0);
    view.finishAll(2000);
    expect(view.frame(2000, 120)).toEqual({ done: ["✔   2.0s Working: checking the login"], live: [] });
  });
});
