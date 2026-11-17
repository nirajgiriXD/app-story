import { describe, expect, it } from "vitest";
import type { Step, StepResult } from "@app-story/contracts";
import { parseProductFile } from "@app-story/products";
import { curveControl } from "@app-story/browser";
import { buildAudioMix, buildRenderProps, cursorPresence, getTemplate, planTimeline, shotBox, soundEffects, type BuildPropsInput } from "@app-story/video";

const { config } = parseProductFile("---\nurl: https://acme.test\n---\n\n# Acme\n", "acme.md", "acme");
const template = getTemplate("modern-saas");

function props(overrides: Partial<BuildPropsInput> = {}) {
  return buildRenderProps({
    config,
    template,
    plan: planTimeline({ template, recordingMs: 20_000 }),
    title: "Create a project",
    recordingSrc: "recording.mp4",
    recordingMs: 20_000,
    workflowSteps: [],
    results: [],
    cursor: [],
    startUrl: "https://acme.test/projects",
    placements: [],
    cues: [],
    ...overrides,
  });
}

const result = (o: Partial<StepResult> & Pick<StepResult, "step_id" | "action" | "started_ms" | "ended_ms">): StepResult => ({
  description: o.step_id,
  status: "passed",
  attempts: 1,
  verified: true,
  ...o,
});

describe("render props", () => {
  it("changes the address bar when the page changed, not when the step finished", () => {
    const p = props({
      workflowSteps: [{ id: "s1", description: "open", action: "click", target: { name: "New" } } as Step],
      results: [result({ step_id: "s1", action: "click", started_ms: 1000, ended_ms: 4000, url_after: "https://acme.test/projects/new" })],
      navigations: [
        { t: 0, url: "https://acme.test/projects" },
        { t: 1800, url: "https://acme.test/projects/new" },
      ],
    });
    expect(p.urls).toEqual([
      { atMs: 0, url: "https://acme.test/projects" },
      { atMs: 1800, url: "https://acme.test/projects/new" },
    ]);
  });

  it("falls back to step ends for takes recorded without page changes", () => {
    const p = props({
      workflowSteps: [{ id: "s1", description: "open", action: "click", target: { name: "New" } } as Step],
      results: [result({ step_id: "s1", action: "click", started_ms: 1000, ended_ms: 4000, url_after: "https://acme.test/projects/new" })],
    });
    expect(p.urls.map((u) => u.atMs)).toEqual([0, 4000]);
  });
});

describe("captions on title cards", () => {
  it("leaves out a caption that repeats the card's own text, but keeps the rest", () => {
    const plan = planTimeline({ template, recordingMs: 20_000, introAudioMs: 3000 });
    const p = props({
      plan,
      subtitle: "Set up a project in a few seconds.",
      placements: [
        { src: "intro.wav", text: "Set up a project in a few seconds", startMs: 450, durationMs: 3000 },
        { src: "seg.wav", text: "Open the form.", startMs: plan.recordingStartMs + 500, durationMs: 1500 },
      ],
      cues: [
        { start_ms: 450, end_ms: 3450, text: "Set up a project in a few seconds" },
        { start_ms: plan.recordingStartMs + 500, end_ms: plan.recordingStartMs + 2000, text: "Open the form." },
      ],
    });
    expect(p.captions.cues.map((c) => c.text)).toEqual(["Open the form."]);
  });
});

describe("shots", () => {
  const form = { x: 300, y: 150, width: 700, height: 500 };
  const steps = [
    { id: "s1", description: "open", action: "click", target: { name: "New" } },
    { id: "s2", description: "name", action: "fill", target: { label: "Name" }, value: "Q3" },
    { id: "s3", description: "check", action: "assert", expected: { type: "text_present", text: "Created" } },
  ] as Step[];

  it("frames an action's whole area and a check's verified outcome", () => {
    expect(
      shotBox(result({ step_id: "s2", action: "fill", started_ms: 0, ended_ms: 1, box: { x: 320, y: 200, width: 600, height: 40 }, region: form })),
    ).toEqual(form);
    const toast = { x: 400, y: 60, width: 300, height: 40 };
    expect(shotBox(result({ step_id: "s3", action: "assert", started_ms: 0, ended_ms: 1, result_box: toast }))).toEqual(toast);
    expect(shotBox(result({ step_id: "s3", action: "assert", started_ms: 0, ended_ms: 1 }))).toBeUndefined();
  });

  it("ends a shot just before the page changes, and gives the result its own shot", () => {
    const p = props({
      workflowSteps: steps,
      results: [
        result({ step_id: "s1", action: "click", started_ms: 1000, ended_ms: 3000, box: { x: 1300, y: 40, width: 130, height: 40 } }),
        result({ step_id: "s2", action: "fill", started_ms: 5000, ended_ms: 7000, box: { x: 320, y: 200, width: 600, height: 40 }, region: form }),
        result({ step_id: "s3", action: "assert", started_ms: 9000, ended_ms: 9100, result_box: { x: 400, y: 60, width: 300, height: 40 } }),
      ],
      navigations: [
        { t: 0, url: "https://acme.test/projects" },
        { t: 1800, url: "https://acme.test/projects/new" },
      ],
    });
    expect(p.cuts).toEqual([1800]);
    expect(p.focus.map((f) => [f.startMs, f.endMs])).toEqual([
      [1000, 1600],
      [5000, 9000],
      [9000, 17100],
    ]);
  });
});

describe("pointer", () => {
  const points = [
    { t: 0, x: 800, y: 450 },
    { t: 1000, x: 800, y: 450 },
    { t: 1600, x: 300, y: 200 },
    { t: 1700, x: 300, y: 200, click: true },
  ];

  it("hides while it rests and comes back just before it moves", () => {
    expect(cursorPresence(500, points)).toBe(0); // resting since the start
    expect(cursorPresence(900, points)).toBeGreaterThan(0); // fading in before the move
    expect(cursorPresence(1300, points)).toBe(1); // moving
    expect(cursorPresence(1700 + 2000, points)).toBe(1); // still shown a while after the click
    expect(cursorPresence(1700 + 5000, points)).toBe(0); // gone after resting
  });

  it("moves in a gentle upward arc", () => {
    const bend = curveControl({ x: 0, y: 500 }, { x: 1000, y: 500 });
    expect(bend.x).toBeCloseTo(500);
    expect(bend.y).toBeLessThan(500);
    expect(curveControl({ x: 1000, y: 500 }, { x: 0, y: 500 }).y).toBeLessThan(500);
  });
});

describe("sound effects", () => {
  it("ticks on clicks, taps while typing, whooshes in and out, and chimes on the outcome", () => {
    const plan = planTimeline({ template, recordingMs: 20_000 });
    const cursor = [
      { t: 0, x: 0, y: 0 },
      { t: 1500, x: 10, y: 10, click: true },
      { t: 5200, x: 20, y: 20, click: true },
    ];
    const effects = soundEffects(
      [
        result({ step_id: "s1", action: "click", started_ms: 1000, ended_ms: 2000 }),
        result({ step_id: "s2", action: "fill", started_ms: 5000, ended_ms: 7000 }),
        result({ step_id: "s3", action: "assert", started_ms: 9000, ended_ms: 9100, result_box: { x: 0, y: 0, width: 10, height: 10 } }),
      ],
      cursor,
      plan,
      template.transitionMs,
    );
    const at = (ms: number) => plan.recordingStartMs + ms;
    expect(effects.map((e) => e.kind)).toEqual(["whoosh", "click", "click", "typing", "chime", "whoosh"]);
    expect(effects.find((e) => e.kind === "typing")).toEqual({ kind: "typing", atMs: at(5280), durationMs: 1680 });
    expect(effects.find((e) => e.kind === "chime")!.atMs).toBe(at(9150));
  });

  it("are mixed with the voice", () => {
    const p = props({
      results: [],
      cursor: [
        { t: 0, x: 0, y: 0 },
        { t: 1000, x: 5, y: 5, click: true },
      ],
    });
    const mix = buildAudioMix(p, 0, (src) => src);
    expect(mix.filter).toContain("aevalsrc=");
    expect(mix.filter).toMatch(/\[s\d+\]/);
    expect(getTemplate("minimal").sounds).toBe(false);
  });
});
