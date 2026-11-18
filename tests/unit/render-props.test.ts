import { describe, expect, it } from "vitest";
import { menuLayout, type Step, type StepResult } from "@app-story/contracts";
import { parseProductFile } from "@app-story/products";
import { curveControl } from "@app-story/browser";
import {
  BRAND_FONT_FAMILY,
  brandFontCss,
  buildAudioMix,
  buildRenderProps,
  interCss,
  luminance,
  cursorPresence,
  cursorShape,
  editTimes,
  getTemplate,
  menuAt,
  planEdit,
  planTimeline,
  shotBox,
  soundEffects,
  toOtio,
  type BuildPropsInput,
} from "@app-story/video";

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

  it("shows the keys of every key press that happened on camera", () => {
    const p = props({
      workflowSteps: [
        { id: "s1", description: "open search", action: "press", key: "Control+K" } as Step,
        { id: "s2", description: "submit", action: "press", key: "Enter" } as Step,
      ],
      results: [
        result({ step_id: "s1", action: "press", started_ms: 1000, ended_ms: 1500 }),
        result({ step_id: "s2", action: "press", started_ms: 3000, ended_ms: 3400, status: "failed" }),
      ],
    });
    expect(p.keys).toEqual([{ atMs: 1000, labels: ["Ctrl", "K"] }]);
  });

  it("shows the public website, not the staging app, in the browser bar and on the end card", () => {
    const staging = parseProductFile(
      '---\nurl: https://staging.acme.test\nwebsite: https://acme.com\ncta: "Start free at {host}"\n---\n\n# Acme\n',
      "acme.md",
      "acme",
    ).config;
    const p = props({
      config: staging,
      startUrl: "https://staging.acme.test/projects?tab=all",
      navigations: [
        { t: 0, url: "https://staging.acme.test/projects?tab=all" },
        { t: 900, url: "https://docs.other.test/help" },
      ],
    });
    expect(p.urls.map((u) => u.url)).toEqual(["https://acme.com/projects?tab=all", "https://docs.other.test/help"]);
    expect(p.brand).toMatchObject({ host: "acme.com", cta: "Start free at {host}" });
    // Without a website, the app's own address is shown, as before.
    expect(props().brand).toMatchObject({ host: "acme.test", cta: "Try it at {host}" });
  });

  it("puts the brand's own backdrop behind the video, with words that read on it", () => {
    const branded = (setting: string) => parseProductFile(`---\nurl: https://acme.test\nbackground: ${setting}\n---\n\n# Acme\n`, "acme.md", "acme").config;
    expect(props({ config: branded('"#0B1020"') }).brand.background).toEqual({ color: "#0B1020" });
    expect(props({ config: branded("brand/bg.jpg"), backgroundSrc: "assets/background.jpg" }).brand.background).toEqual({ image: "assets/background.jpg" });
    expect(props().brand.background).toBeNull();
    expect(luminance("#0B1020")).toBeLessThan(0.05);
    expect(luminance("#F8FAFC")).toBeGreaterThan(0.9);
  });

  it("ships Inter with the render page and loads a brand font file under its own name", async () => {
    const css = await interCss();
    expect(css).toContain("font-family: 'Inter'");
    expect(css).toContain("font-display: block");
    expect(css).toContain("url(/fonts/inter/inter-latin-wght-normal.woff2)");
    expect(css).not.toContain("./files/");

    expect(props().brand).toMatchObject({ font: "Inter", fontFile: null });
    expect(props({ fontSrc: "assets/font.woff2" }).brand).toMatchObject({ font: BRAND_FONT_FAMILY, fontFile: "assets/font.woff2" });
    expect(brandFontCss("/files/assets/font.woff2")).toContain(`font-family:'${BRAND_FONT_FAMILY}'`);
  });
});

describe("pointer shape", () => {
  it("is an arrow while it travels and takes the page's shape where it lands", () => {
    const points = [
      { t: 0, x: 0, y: 0 },
      { t: 100, x: 10, y: 10, shape: "arrow" as const },
      { t: 400, x: 50, y: 50, shape: "hand" as const },
      { t: 600, x: 50, y: 50, click: true, shape: "hand" as const },
      { t: 900, x: 60, y: 60, shape: "arrow" as const },
      { t: 1200, x: 90, y: 90, shape: "text" as const },
    ];
    expect([0, 200, 450, 700, 1000, 1500].map((t) => cursorShape(t, points))).toEqual(["arrow", "arrow", "hand", "hand", "arrow", "text"]);
  });
});

describe("native dropdowns", () => {
  const field = { x: 400, y: 300, width: 300, height: 36 };
  const menu = { options: ["Planning", "In progress", "On hold"], from: 0, to: 2, opened_ms: 2000, closed_ms: 3100 };

  it("draws the list under the field, or above it when there is no room below", () => {
    expect(menuLayout(field, menu, { width: 1600, height: 900 })).toEqual({ x: 400, y: 340, width: 300, rowHeight: 36, first: 0, rows: 3 });
    const low = { ...field, y: 840 };
    expect(menuLayout(low, menu, { width: 1600, height: 900 }).y).toBe(840 - 4 - (3 * 36 + 8));
    // A long list shows a window of rows around the chosen option.
    const many = { options: Array.from({ length: 30 }, (_, i) => `Option ${i}`), to: 20 };
    expect(menuLayout(field, many, { width: 1600, height: 2000 })).toMatchObject({ first: 16, rows: 8 });
  });

  it("keeps the list a step opened on the edited timeline, with its field", () => {
    const p = props({
      workflowSteps: [{ id: "s1", description: "status", action: "select", target: { label: "Status" }, value: "On hold" } as Step],
      results: [result({ step_id: "s1", action: "select", started_ms: 1500, ended_ms: 3500, box: field, menu })],
    });
    expect(p.menus).toEqual([{ openMs: 2000, closeMs: 3100, field, options: menu.options, from: 0, to: 2 }]);
    const map = planEdit(10_000, [[0, 10_000]]);
    expect(
      editTimes(map, {
        durationMs: 10_000,
        steps: [result({ step_id: "s1", action: "select", started_ms: 1500, ended_ms: 3500, menu })],
        cursor: [],
        voice: [],
      }).steps[0]?.menu,
    ).toEqual(menu);
  });

  it("opens and closes softly", () => {
    const menus = [{ openMs: 1000, closeMs: 2000 }];
    expect(menuAt(999, menus)).toBeUndefined();
    expect(menuAt(1000, menus)?.shown).toBe(0);
    expect(menuAt(1500, menus)?.shown).toBe(1);
    expect(menuAt(2090, menus)?.shown).toBeGreaterThan(0);
    expect(menuAt(2090, menus)?.shown).toBeLessThan(1);
    expect(menuAt(2300, menus)).toBeUndefined();
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

  it("moves a caption to the top while it would cover what a full-screen shot shows", () => {
    const full = getTemplate("tutorial");
    const plan = planTimeline({ template: full, recordingMs: 20_000 });
    const at = (ms: number) => plan.recordingStartMs + ms;
    const input: Partial<BuildPropsInput> = {
      template: full,
      plan,
      workflowSteps: [
        { id: "s1", description: "open", action: "click", target: { name: "Reports" } } as Step,
        { id: "s2", description: "save", action: "click", target: { name: "Save" } } as Step,
      ],
      results: [
        result({ step_id: "s1", action: "click", started_ms: 1000, ended_ms: 2000, box: { x: 700, y: 40, width: 120, height: 36 } }),
        result({ step_id: "s2", action: "click", started_ms: 8000, ended_ms: 9000, box: { x: 1300, y: 830, width: 140, height: 44 } }),
      ],
      cues: [
        { start_ms: at(1000), end_ms: at(2500), text: "Open the reports." },
        { start_ms: at(8000), end_ms: at(9500), text: "Then save it." },
      ],
    };
    expect(props(input).captions.cues.map((c) => [c.text, c.position])).toEqual([
      ["Open the reports.", "bottom"],
      ["Then save it.", "top"],
    ]);
    // A window keeps captions in a zone of their own: nothing moves.
    expect(props({ ...input, template }).captions.cues.map((c) => c.position)).toEqual([undefined, undefined]);
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

describe("editable timeline", () => {
  it("lays out the take and the voice for an editor, cutting fast-forwarded stretches", () => {
    const plan = planTimeline({ template, recordingMs: 10_000 });
    const p = props({
      plan,
      recordingMs: 10_000,
      // 0-4 s as recorded, then 8 s of take shown in 2 s, then 4 s as recorded.
      timeMap: [
        [0, 0],
        [4000, 4000],
        [6000, 12_000],
        [10_000, 16_000],
      ],
      placements: [{ src: "narration/seg-01.wav", text: "Hi.", startMs: plan.recordingStartMs + 500, durationMs: 2000 }],
      workflowSteps: [{ id: "s1", description: "open", action: "click", target: { name: "New" }, section: "Start" } as Step],
      results: [result({ step_id: "s1", action: "click", started_ms: 500, ended_ms: 900 })],
    });
    const otio = JSON.parse(toOtio(p, (src) => `take/${src}`));
    const [app, voice] = otio.tracks.children;
    const frames = (ms: number) => Math.round((ms * p.fps) / 1000);
    expect(app.children.map((c: { OTIO_SCHEMA: string }) => c.OTIO_SCHEMA)).toEqual(["Gap.1", "Clip.2", "Clip.2", "Clip.2"]);
    const cut = app.children[2];
    expect(cut.source_range.duration.value).toBe(frames(2000));
    expect(cut.source_range.start_time.value).toBe(frames(4000 + 3000)); // the middle of the skipped 8 s
    expect(cut.media_references.DEFAULT_MEDIA.target_url).toBe("take/recording.mp4");
    expect(app.markers[0].name).toBe("Start");
    expect(voice.children.map((c: { OTIO_SCHEMA: string }) => c.OTIO_SCHEMA)).toEqual(["Gap.1", "Clip.2"]);
    expect(voice.children[0].source_range.duration.value).toBe(frames(plan.recordingStartMs + 500));
  });
});
