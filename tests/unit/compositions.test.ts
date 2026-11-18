import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Step, StepResult } from "@app-story/contracts";
import { parseProductFile } from "@app-story/products";
import { buildRenderProps, getTemplate, placeNarration, reshapeProps, type RenderProps } from "@app-story/video";
// The compositions are not part of the package's API (the CLI bundle must not load React).
import { DemoVideo } from "../../packages/video/src/compositions/DemoVideo";
import { VideoRoot } from "../../packages/video/src/compositions/runtime";

/*
 * Golden frames: what the video draws at a few moments, as markup. Any change to the look
 * (layout, motion, captions, the pointer, the dropdown) shows up here as a snapshot diff,
 * to be accepted on purpose (`npx vitest -u`) or fixed. Markup, not pixels, so the
 * snapshots are the same on every machine and font set.
 */

const { config } = parseProductFile(
  '---\nurl: https://staging.acme.test\nwebsite: https://acme.com\ncta: "Start free at {host}"\ncolor: "#4F46E5"\n---\n\n# Acme\n',
  "acme.md",
  "acme",
);

function props(template = "product-update"): RenderProps {
  const t = getTemplate(template);
  const { plan, placements } = placeNarration({
    template: t,
    recordingMs: 12_000,
    intro: { id: "intro", kind: "intro", text: "Export every invoice at once.", step_ids: [], path: "intro.wav", duration_ms: 2400 },
    outro: { id: "outro", kind: "outro", text: "Try it today.", step_ids: [], path: "outro.wav", duration_ms: 1200 },
    segments: [{ id: "seg-01", kind: "segment", text: "Pick an owner.", step_ids: ["s2"], path: "seg.wav", duration_ms: 1800, start_ms: 3000 }],
    toSrc: (p) => p,
  });
  const result = (o: Partial<StepResult> & Pick<StepResult, "step_id" | "action" | "started_ms" | "ended_ms">): StepResult => ({
    description: o.step_id,
    status: "passed",
    attempts: 1,
    verified: true,
    ...o,
  });
  const field = { x: 900, y: 400, width: 320, height: 36 };
  return buildRenderProps({
    config,
    template: t,
    plan,
    title: "Export invoices in bulk",
    subtitle: "Pick many invoices and download one CSV.",
    recordingSrc: "recording.mp4",
    recordingMs: 12_000,
    workflowSteps: [
      { id: "s1", description: "Open reports", action: "click", target: { name: "Reports" }, section: "Open reports" },
      { id: "s2", description: "Pick an owner", action: "select", target: { label: "Owner" }, value: "Priya Patel", section: "Choose" },
    ] as Step[],
    results: [
      result({ step_id: "s1", action: "click", started_ms: 800, ended_ms: 2200, box: { x: 200, y: 120, width: 120, height: 36 } }),
      result({
        step_id: "s2",
        action: "select",
        started_ms: 3000,
        ended_ms: 5200,
        box: field,
        region: { x: 860, y: 300, width: 420, height: 260 },
        menu: { options: ["Ava Chen", "Marcus Lee", "Priya Patel"], from: 0, to: 2, opened_ms: 3600, closed_ms: 4700 },
      }),
    ],
    cursor: [
      { t: 0, x: 800, y: 450 },
      { t: 300, x: 500, y: 300, shape: "arrow" },
      { t: 800, x: 260, y: 138, shape: "hand" },
      { t: 900, x: 260, y: 138, click: true, shape: "hand" },
      { t: 3100, x: 700, y: 300, shape: "arrow" },
      { t: 3550, x: 1060, y: 418 },
      { t: 3600, x: 1060, y: 418, click: true },
      { t: 4300, x: 1000, y: 516 },
      { t: 4700, x: 1000, y: 516, click: true },
    ],
    startUrl: "https://staging.acme.test/reports",
    placements,
    cues: placements.map((p) => ({ start_ms: p.startMs, end_ms: p.startMs + p.durationMs, text: p.text })),
  });
}

function frameAt(p: RenderProps, ms: number): string {
  const frame = Math.round((ms / 1000) * p.fps);
  const config = { fps: p.fps, width: p.width, height: p.height, durationInFrames: Math.round((p.durationMs / 1000) * p.fps) };
  return renderToStaticMarkup(createElement(VideoRoot, { frame, config, children: createElement(DemoVideo, p) }));
}

describe("golden frames", () => {
  const p = props();
  const at = (recordingMs: number) => p.recording.startMs + recordingMs;

  it("the title card", () => {
    expect(frameAt(p, 1500)).toMatchSnapshot();
  });

  it("a click on a link, with the pointer as a hand", () => {
    const html = frameAt(p, at(1000));
    expect(html).toContain("acme.com/reports"); // the public website in the browser bar
    expect(html).toMatchSnapshot();
  });

  it("a dropdown opened on camera, with its caption", () => {
    const html = frameAt(p, at(4400));
    expect(html).toContain("Priya Patel");
    expect(html).toContain("Pick an owner.");
    expect(html).toMatchSnapshot();
  });

  it("the end card", () => {
    const html = frameAt(p, p.outro.startMs + 2000);
    expect(html).toContain("Start free at acme.com");
    expect(html).toMatchSnapshot();
  });

  it("the vertical version of the dropdown", () => {
    const tall = reshapeProps(p, "vertical");
    expect(frameAt(tall, at(4400))).toMatchSnapshot();
  });
});
