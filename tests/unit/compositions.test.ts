import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Step, StepResult } from "@app-story/contracts";
import { parseProductFile } from "@app-story/products";
import { buildRenderProps, drawnFrame, getTemplate, placeNarration, reshapeProps, type RenderProps } from "@app-story/video";
// The compositions are not part of the package's API (the CLI bundle must not load React).
import { DemoVideo } from "../../packages/video/src/compositions/DemoVideo";
import { captionHeight, layout, PORTRAIT_SAFE } from "../../packages/video/src/compositions/layout";
import { VideoRoot } from "../../packages/video/src/compositions/runtime";

/*
 * Golden frames: what the video draws at a few moments, as markup. Any change to the look
 * (layout, motion, captions, the pointer, the dropdown) shows up here as a snapshot diff,
 * to be accepted on purpose (`npx vitest -u`) or fixed. Markup, not pixels, so the
 * snapshots are the same on every machine and font set.
 */

const { config: base } = parseProductFile(
  '---\nurl: https://staging.acme.test\nwebsite: https://acme.com\ncta: "Start free at {host}"\ncolor: "#4F46E5"\n---\n\n# Acme\n',
  "acme.md",
  "acme",
);

/** `look`: the intro, captions and chapter labels on the video, as `--intro`, `--captions` and `--chapters` ask (default: all, as most frames below check them). */
function props(template = "product-update", look = { intro: true, captions: true, chapters: true }): RenderProps {
  const t = getTemplate(template);
  const config = structuredClone(base);
  config.demo.intro = look.intro;
  config.captions.burn_in = look.captions;
  config.demo.chapters = look.chapters;
  const { plan, placements } = placeNarration({
    introSequence: look.intro,
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

/** The words a frame's markup shows, without its tags (the intro's title comes in word by word). */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** One layer of a frame's markup (a named Sequence), up to the next one. */
function layer(html: string, name: string): string {
  const from = html.indexOf(`data-sequence="${name}"`);
  if (from < 0) return "";
  const next = html.indexOf('data-sequence="', from + 1);
  return html.slice(from, next < 0 ? undefined : next);
}

describe("golden frames", () => {
  const p = props();
  const at = (recordingMs: number) => p.recording.startMs + recordingMs;

  it("the intro: full screen, the app's first screen behind the title", () => {
    const html = frameAt(p, 1500);
    expect(layer(html, "Recording")).toBe(""); // the app comes after it
    expect(words(layer(html, "Intro"))).toContain("Export invoices in bulk");
    expect(html).toMatchSnapshot();
  });

  it("frame 0 is the poster: the settled intro, not the bare backdrop", () => {
    const poster = drawnFrame(p, 0);
    expect(poster).toBe(Math.round(((p.posterMs as number) / 1000) * p.fps));
    expect(poster).toBeGreaterThan(0);
    expect(poster).toBeLessThan(Math.round((p.recording.startMs / 1000) * p.fps));
    expect(drawnFrame(p, 1)).toBe(1);
    // Never a frame of the recording: a worker reads those in order.
    expect(drawnFrame({ ...p, posterMs: p.recording.startMs + 500 }, 0)).toBe(0);
    expect(words(frameAt(p, p.posterMs as number))).toContain("Export invoices in bulk");
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

  it("the middle of each transition", () => {
    const fade = p.template.transitionMs;
    expect(frameAt(p, p.recording.startMs + fade / 2)).toMatchSnapshot("intro → app");
    expect(frameAt(p, p.outro.startMs + fade / 2)).toMatchSnapshot("app → end card");
  });

  it("never shows the intro's or end card's words and the app at once, on any frame of a transition", () => {
    // How visible a card's words are, read from its layer's markup: the intro fades as a whole
    // (its root) and the words of both rise in one by one (each word or line).
    const card = (segment: string) => {
      if (!segment) return 0;
      const rootStyle = [...segment.matchAll(/style="([^"]*)"/g)][1]?.[1] ?? "";
      const root = Number(/(?:^|;)opacity:([\d.e-]+)/.exec(rootStyle)?.[1] ?? 1);
      const lines = [...segment.matchAll(/opacity:([\d.e-]+);(?:filter:[^;]*;)?transform:translateY\(/g)].map((m) => Number(m[1]));
      return root * Math.max(0, ...lines);
    };
    const app = (html: string) => Number(/opacity:([\d.e-]+)/.exec(layer(html, "Recording"))?.[1] ?? 0);
    const fade = p.template.transitionMs;
    const step = 1000 / p.fps;
    for (const [start, name] of [
      [p.recording.startMs, "Intro"],
      [p.outro.startMs, "Outro"],
    ] as const) {
      let seen = 0;
      for (let ms = start; ms <= start + fade; ms += step) {
        const html = frameAt(p, ms);
        seen = Math.max(seen, card(layer(html, name)));
        // A double exposure: both clearly there in the same frame.
        expect(Math.min(card(layer(html, name)), app(html)), `${name} at ${Math.round(ms)} ms`).toBeLessThan(0.15);
      }
      expect(seen, `${name} is found in the markup`).toBeGreaterThan(0.5);
    }
  });

  it("the vertical version of the dropdown", () => {
    const tall = reshapeProps(p, "vertical");
    expect(frameAt(tall, at(4400))).toMatchSnapshot();
  });

  it("the vertical version keeps its words where Reels, TikTok and Shorts draw nothing", () => {
    const tall = reshapeProps(p, "vertical");
    const right = `${PORTRAIT_SAFE.right}px`; // a 1080-wide frame: design px are output px
    // Below the platform's top bar: the window, and the chapter chip above it.
    expect(layout(tall).y).toBeGreaterThanOrEqual(tall.height * PORTRAIT_SAFE.top);
    expect(frameAt(tall, at(1000))).toContain(`top:${tall.height * PORTRAIT_SAFE.top}px`);
    // The caption: clear of the buttons on the right, and above the platform's caption.
    const caption = frameAt(tall, at(4400));
    const under = Number(/padding:([\d.]+)px (\d+)px 0/.exec(caption)?.[1]);
    expect(caption).toContain(`px ${right} 0`);
    expect(under + captionHeight(tall)).toBeLessThanOrEqual(tall.height * PORTRAIT_SAFE.bottom);
    // The intro and the end card: their words clear of the buttons too.
    expect(frameAt(tall, 1500)).toContain(`padding:0 ${right}`);
    expect(frameAt(tall, tall.outro.startMs + 2000)).toContain(`padding:0 ${right} 0`);
  });
});

describe("opening on the app (no --intro, no --captions)", () => {
  const p = props("product-update", { intro: false, captions: false, chapters: false });

  it("draws no chapter label, but keeps the chapters for the MP4", () => {
    expect(frameAt(props(), props().recording.startMs + 1000)).toContain(">Open reports<"); // with --chapters
    expect(frameAt(p, p.recording.startMs + 1000)).not.toContain(">Open reports<");
    expect(p.sections.map((s) => s.title)).toEqual(["Open reports", "Choose"]);
  });

  it("shows the app's first screen from frame 0, held while the intro line is spoken", () => {
    expect(p.intro.endMs).toBe(0);
    expect(p.recording.holdMs).toBe(450 + 2400 + 350);
    expect(p.recording.startMs).toBe(p.recording.holdMs);
    for (const ms of [0, 1000, p.recording.startMs - 20]) {
      const html = frameAt(p, ms);
      expect(layer(html, "Intro")).toBe("");
      expect(layer(html, "Recording")).toMatch(/^[^>]*><div style="[^"]*opacity:1;/); // there at once, no fade in
      expect(html).toContain("/recording/0.jpg"); // still the take's first frame
    }
    // Then the take plays.
    expect(frameAt(p, p.recording.startMs + 1000)).toContain("/recording/60.jpg");
  });

  it("frame 0 is the app itself, and the poster", () => {
    expect(p.posterMs).toBe(0);
    expect(drawnFrame(p, 0)).toBe(0);
    expect(frameAt(p, 0)).toMatchSnapshot();
  });

  it("draws no captions on the video", () => {
    const html = frameAt(p, p.recording.startMs + 4400);
    expect(html).toContain("Priya Patel"); // the dropdown is there
    expect(html).not.toContain("Pick an owner."); // its caption is not
    expect(p.captions.cues.map((c) => c.text)).toContain("Pick an owner."); // still timed, for the .srt
  });
});
