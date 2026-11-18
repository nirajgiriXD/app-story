import { describe, expect, it } from "vitest";
import { buildCues, chunkText, toSrt, toVtt, wrapLines } from "@app-story/captions";
import { alignWords, canTimeWords } from "@app-story/narration";
import { cameraAt, cameraTransform, cursorAt, frameBox, getTemplate, mergeFocusWindows, planTimeline, TEMPLATES } from "@app-story/video";

describe("captions", () => {
  it("splits into sentences and screen-sized chunks", () => {
    const chunks = chunkText("First sentence. A much longer second sentence that keeps going, and going, and going well past the limit.", 50);
    expect(chunks[0]).toBe("First sentence.");
    expect(chunks.every((c) => c.length <= 50)).toBe(true);
    expect(chunks.join(" ")).toContain("well past the limit.");
  });

  it("splits a long sentence into even chunks, never a lonely last few words", () => {
    const text = "The confirmation shows the project was created, and it's highlighted at the top of the list, ready for your team.";
    const chunks = chunkText(text, 104);
    expect(chunks).toHaveLength(2);
    expect(chunks.join(" ")).toBe(text);
    const [a, b] = chunks.map((c) => c.length) as [number, number];
    expect(Math.min(a, b) / Math.max(a, b)).toBeGreaterThan(0.6);
    expect(chunks[0]).toMatch(/,$/);
  });

  it("wraps long chunks into two balanced lines", () => {
    const text = "This is the Projects page where you can see everything";
    const wrapped = wrapLines(text, 40);
    expect(wrapped.split("\n")).toHaveLength(2);
    expect(wrapped.replace("\n", " ")).toBe(text);
  });

  it("times cues inside their narration clip without overlap", () => {
    const cues = buildCues(
      [
        { text: "Open the form. Then name the project.", start_ms: 1000, duration_ms: 4000 },
        { text: "Save it.", start_ms: 6000, duration_ms: 1000 },
      ],
      { maxCharsPerLine: 40, maxLines: 2 },
    );
    expect(cues).toHaveLength(3);
    expect(cues[0]!.start_ms).toBe(1000);
    expect(cues[1]!.end_ms).toBeLessThanOrEqual(5000);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start_ms).toBeGreaterThanOrEqual(cues[i - 1]!.end_ms);
  });

  it("formats SRT and WebVTT timestamps", () => {
    const cues = [{ index: 1, start_ms: 61_234, end_ms: 3_725_005, text: "Hello" }];
    expect(toSrt(cues)).toContain("00:01:01,234 --> 01:02:05,005");
    expect(toVtt(cues)).toMatch(/^WEBVTT\n\n00:01:01\.234 --> 01:02:05\.005\nHello/);
  });
});

describe("video timeline", () => {
  const template = getTemplate("modern-saas");

  it("stretches cards to fit narration and overlaps transitions", () => {
    const plan = planTimeline({ template, recordingMs: 20_000, introAudioMs: 6000, outroAudioMs: 1000 });
    expect(plan.introEndMs).toBe(6000 + 600 + template.transitionMs);
    expect(plan.recordingStartMs).toBe(plan.introEndMs - template.transitionMs);
    expect(plan.outroStartMs).toBe(plan.recordingEndMs - template.transitionMs);
    expect(plan.totalMs).toBe(plan.outroEndMs);
  });

  it("ships the five templates from the README", () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(["feature-highlight", "minimal", "modern-saas", "product-update", "tutorial"]);
    expect(() => getTemplate("nope")).toThrow(/Available/);
  });

  it("zooms toward a focused element and back out", () => {
    const viewport = { width: 1600, height: 900 };
    const box = { x: 1200, y: 100, width: 200, height: 40 };
    const groups = mergeFocusWindows([{ startMs: 1000, endMs: 2000, box }]);
    const zoom = { scale: 1.4, rampMs: 500 };
    expect(cameraAt(0, groups, viewport, zoom).scale).toBe(1);
    const mid = cameraAt(1500, groups, viewport, zoom);
    expect(mid.scale).toBeGreaterThanOrEqual(1.4);
    expect(mid.scale).toBeLessThanOrEqual(1.4 * 1.04); // a slow push-in while it holds
    expect(mid.x).toBeCloseTo(1300);
    expect(cameraAt(3000, groups, viewport, zoom).scale).toBe(1);
    // The view never leaves the frame.
    const t = cameraTransform(mid, viewport);
    expect(-t.tx).toBeLessThanOrEqual(viewport.width - viewport.width / mid.scale + 0.001);
    expect(-t.ty).toBeGreaterThanOrEqual(0);
  });

  it("frames the whole area of a step, not just the element or the pointer", () => {
    const viewport = { width: 1600, height: 900 };
    const form = { x: 300, y: 150, width: 700, height: 500 };
    const groups = mergeFocusWindows([{ startMs: 1000, endMs: 3000, box: form }]);
    const camera = cameraAt(2000, groups, viewport, { scale: 1.6, rampMs: 500 });
    expect(camera.scale).toBeGreaterThan(1.1);
    const view = cameraTransform(camera, viewport);
    // Every edge of the form is in view.
    expect(form.x).toBeGreaterThanOrEqual(-view.tx);
    expect(form.y).toBeGreaterThanOrEqual(-view.ty);
    expect(form.x + form.width).toBeLessThanOrEqual(-view.tx + viewport.width / view.scale);
    expect(form.y + form.height).toBeLessThanOrEqual(-view.ty + viewport.height / view.scale);
    expect(frameBox(form, viewport, 1.6).scale).toBeCloseTo(1.44);
  });

  it("glides from area to area without jumping", () => {
    const viewport = { width: 1600, height: 900 };
    const zoom = { scale: 1.5, rampMs: 500 };
    const groups = mergeFocusWindows([
      { startMs: 1000, endMs: 2000, box: { x: 250, y: 180, width: 100, height: 40 } },
      { startMs: 2000, endMs: 4000, box: { x: 1250, y: 680, width: 100, height: 40 } },
    ]);
    let last = cameraAt(500, groups, viewport, zoom);
    for (let t = 500; t <= 5000; t += 1000 / 60) {
      const camera = cameraAt(t, groups, viewport, zoom);
      expect(Math.hypot(camera.x - last.x, camera.y - last.y)).toBeLessThan(30);
      expect(Math.abs(camera.scale - last.scale)).toBeLessThan(0.05);
      last = camera;
    }
    expect(cameraAt(3500, groups, viewport, zoom)).toMatchObject({ x: 1300, y: 700 });
  });

  it("pulls back for a page change, even between close steps", () => {
    const viewport = { width: 1600, height: 900 };
    const zoom = { scale: 1.5, rampMs: 500 };
    const box = { x: 100, y: 100, width: 100, height: 40 };
    const windows = [
      { startMs: 1000, endMs: 2000, box },
      { startMs: 2600, endMs: 4000, box },
    ];
    expect(mergeFocusWindows(windows)).toHaveLength(1);
    const groups = mergeFocusWindows(windows, 1200, [2100]);
    expect(groups).toHaveLength(2);
    expect(cameraAt(2300, groups, viewport, zoom).scale).toBe(1);
    let last = cameraAt(1900, groups, viewport, zoom);
    for (let t = 1900; t <= 2700; t += 1000 / 60) {
      const camera = cameraAt(t, groups, viewport, zoom);
      expect(Math.abs(camera.scale - last.scale)).toBeLessThan(0.05); // the shortened ramps never jump
      last = camera;
    }
  });

  it("merges nearby focus windows so the camera pans", () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    const groups = mergeFocusWindows([
      { startMs: 0, endMs: 1000, box },
      { startMs: 1500, endMs: 2000, box },
      { startMs: 6000, endMs: 7000, box },
    ]);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });

  it("interpolates the cursor and tracks clicks", () => {
    const points = [
      { t: 0, x: 0, y: 0 },
      { t: 100, x: 100, y: 50 },
      { t: 150, x: 100, y: 50, click: true },
    ];
    expect(cursorAt(50, points)).toEqual({ x: 50, y: 25, sinceClickMs: null });
    expect(cursorAt(400, points)).toEqual({ x: 100, y: 50, sinceClickMs: 250 });
  });
});

describe("caption lines", () => {
  it("breaks two lines where they come out closest in length", () => {
    const [a, b] = wrapLines("Set up a project in a few seconds and see it on your team's list.", 52).split("\n") as [string, string];
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(8);
  });
});

describe("word timing", () => {
  const w = (text: string, start_ms: number, end_ms: number) => ({ text, start_ms, end_ms });

  it("keeps the script's words and takes the times of the words heard", () => {
    const heard = [w("Give", 0, 400), w("the", 400, 540), w("project", 540, 860), w("a", 860, 1100), w("clear", 1100, 1280), w("name", 1280, 1660)];
    expect(alignWords("Give the project a clear name.", heard, 2000)).toEqual([
      w("Give", 0, 400),
      w("the", 400, 540),
      w("project", 540, 860),
      w("a", 860, 1100),
      w("clear", 1100, 1280),
      w("name.", 1280, 1660),
    ]);
  });

  it("survives misheard, missing and extra words without shifting the rest", () => {
    // "Q3" heard as "queue three", "Launch" not heard at all.
    const heard = [w("like", 0, 300), w("queue", 300, 500), w("three", 500, 700), w("Product", 700, 1000)];
    const words = alignWords("like Q3 Product Launch.", heard, 1600);
    expect(words.map((x) => x.text)).toEqual(["like", "Q3", "Product", "Launch."]);
    expect(words[0]).toEqual(w("like", 0, 300));
    expect(words[2]).toEqual(w("Product", 700, 1000));
    expect(words[3]!.start_ms).toBeGreaterThanOrEqual(1000); // shared out after the last word heard
    expect(words[3]!.end_ms).toBeLessThanOrEqual(1600);
    for (let i = 1; i < words.length; i++) expect(words[i]!.start_ms).toBeGreaterThanOrEqual(words[i - 1]!.start_ms);
  });

  it("times words in every language written with spaces", () => {
    for (const language of ["en", "en-GB", "de", "fr-CA", "es", "pt-BR", "hi"]) expect(canTimeWords(language)).toBe(true);
    for (const language of ["ja", "zh-CN", "th"]) expect(canTimeWords(language)).toBe(false);
  });

  it("times each caption by its own first and last word", () => {
    const text = "Open the form. Then name it.";
    const words = [w("Open", 100, 300), w("the", 300, 400), w("form.", 400, 800), w("Then", 2000, 2200), w("name", 2200, 2400), w("it.", 2400, 2700)];
    const cues = buildCues([{ text, start_ms: 1000, duration_ms: 3000, words }], { maxCharsPerLine: 40, maxLines: 2 });
    expect(cues.map((c) => [c.start_ms, c.end_ms])).toEqual([
      [1020, 2200],
      [2920, 4100],
    ]);
  });
});
