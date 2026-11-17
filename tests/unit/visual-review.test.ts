import { afterEach, describe, expect, it } from "vitest";
import { linesToReview, reviewPrompt, stepsToShowWide, visualReviewEnabled } from "@app-story/core";
import type { Workflow } from "@app-story/contracts";

const line = (i: number) => ({ text: `Line ${i}.`, stepIds: [`s${i}`], startMs: i * 1000, durationMs: 1000 });

describe("AI review of the finished video", () => {
  afterEach(() => {
    delete process.env.APP_STORY_AI_REVIEW;
  });

  it("looks at each line past its middle, at most twelve of them", () => {
    const few = linesToReview([line(1), line(2)]);
    expect(few.map((l) => [l.index, l.atMs, l.stepIds])).toEqual([
      [1, 1600, ["s1"]],
      [2, 2600, ["s2"]],
    ]);
    const many = linesToReview(Array.from({ length: 30 }, (_, i) => line(i + 1)));
    expect(many).toHaveLength(12);
    expect(many[0]!.text).toBe("Line 1.");
  });

  it("names each frame's line in the prompt", () => {
    const prompt = reviewPrompt({ title: "Create a project" } as Workflow, linesToReview([line(1), line(2)]));
    expect(prompt).toContain('1. Narration: "Line 1."');
    expect(prompt).toContain('2. Narration: "Line 2."');
  });

  it("shows the steps of failed frames wide, and only those", () => {
    const lines = linesToReview([line(1), line(2), line(3)]);
    const frame = (index: number, ok: boolean, cut = false) => ({
      index,
      subject_visible: ok,
      text_cut_off: cut,
      caption_covers_subject: false,
      issue: ok ? null : "zoomed on empty space",
    });
    const { stepIds, issues } = stepsToShowWide({ frames: [frame(1, true), frame(2, false), frame(3, true, true)] }, lines);
    expect(stepIds).toEqual(["s2", "s3"]);
    expect(issues[0]).toBe("line 2: zoomed on empty space");
  });

  it("can be turned off", () => {
    expect(visualReviewEnabled()).toBe(true);
    process.env.APP_STORY_AI_REVIEW = "off";
    expect(visualReviewEnabled()).toBe(false);
  });
});
