import { describe, expect, it } from "vitest";
import { buildCues, chunkText, toSrt, toVtt, wrapLines } from "@app-story/captions";
import { cameraAt, cameraTransform, cursorAt, followPointer, getTemplate, mergeFocusWindows, planTimeline, TEMPLATES } from "@app-story/video";

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
    expect(mid.scale).toBeCloseTo(1.4);
    expect(mid.x).toBeCloseTo(1300);
    expect(cameraAt(3000, groups, viewport, zoom).scale).toBe(1);
    // The view never leaves the frame.
    const t = cameraTransform(mid, viewport);
    expect(-t.tx).toBeLessThanOrEqual(viewport.width - viewport.width / mid.scale + 0.001);
    expect(-t.ty).toBeGreaterThanOrEqual(0);
  });

  it("follows the pointer while zoomed in, gliding instead of jumping", () => {
    const viewport = { width: 1600, height: 900 };
    const zoom = { scale: 1.5, rampMs: 500 };
    // The pointer rests on one field, then moves across the page to another and stays there.
    const pointer = [
      { t: 0, x: 300, y: 200 },
      { t: 2000, x: 300, y: 200 },
      { t: 2600, x: 1300, y: 700 },
    ];
    const groups = mergeFocusWindows([
      { startMs: 1000, endMs: 2000, box: { x: 250, y: 180, width: 100, height: 40 } },
      { startMs: 2000, endMs: 4000, box: { x: 1250, y: 680, width: 100, height: 40 } },
    ]);
    const follow = followPointer(pointer, 5000);
    const at = (t: number) => cameraAt(t, groups, viewport, zoom, follow);

    expect(at(1800)).toMatchObject({ x: expect.closeTo(300, 0), y: expect.closeTo(200, 0) });
    expect(at(3800)).toMatchObject({ x: expect.closeTo(1300, 0), y: expect.closeTo(700, 0) });
    let last = at(1500);
    for (let t = 1500; t <= 4000; t += 1000 / 30) {
      const camera = at(t);
      expect(camera.x).toBeGreaterThanOrEqual(last.x - 0.5); // always on its way, never back
      expect(Math.hypot(camera.x - last.x, camera.y - last.y)).toBeLessThan(60); // no jumps between frames
      const view = cameraTransform(camera, viewport);
      const p = cursorAt(t, pointer) as { x: number; y: number };
      expect(p.x).toBeGreaterThanOrEqual(-view.tx);
      expect(p.x).toBeLessThanOrEqual(-view.tx + viewport.width / view.scale); // the pointer stays in view
      expect(p.y).toBeLessThanOrEqual(-view.ty + viewport.height / view.scale);
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
