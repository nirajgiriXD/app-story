import { describe, expect, it } from "vitest";
import type { BlogPost } from "@app-story/contracts";
import { normalizePost } from "@app-story/ai";
import { blogMarkdown, shotMoments } from "@app-story/core";

const step = (id: string, ended_ms: number) => ({
  step_id: id,
  action: "click",
  description: id,
  status: "passed",
  started_ms: ended_ms - 1000,
  ended_ms,
  attempts: 1,
  verified: true,
});

const take = (clips: { step_ids: string[]; text: string; kind?: "intro" | "segment" | "outro" }[]) =>
  ({
    workflow: {
      steps: [
        { id: "s1", section: "Open", action: "click", description: "Open" },
        { id: "s2", section: "Open", action: "click", description: "Form" },
        { id: "s3", section: "Save", action: "click", description: "Save" },
      ],
    },
    clips: clips.map((c, i) => ({ id: `c${i}`, kind: c.kind ?? "segment", text: c.text, step_ids: c.step_ids, path: "", duration_ms: 1000 })),
    recorded: {
      report: { steps: [step("s1", 2000), step("s2", 4000), step("s3", 9000)] },
      recording: { path: "rec.mp4", durationMs: 9200 },
    },
  }) as unknown as Parameters<typeof shotMoments>[0];

describe("blog screenshots", () => {
  it("are taken right after the steps of each narration line, without step markers", () => {
    const moments = shotMoments(
      take([
        { kind: "intro", step_ids: [], text: "Hello" },
        { step_ids: ["s1", "s2"], text: "Open the form, {{@s2}}then fill it." },
        { step_ids: ["s3"], text: "Save it." },
      ]),
    );
    expect(moments).toEqual([
      { index: 1, stepIds: ["s1", "s2"], line: "Open the form, then fill it.", atMs: 4300 },
      // Never past the end of the recording.
      { index: 2, stepIds: ["s3"], line: "Save it.", atMs: 9100 },
    ]);
  });

  it("follow the sections when there is no voice", () => {
    expect(shotMoments(take([])).map((m) => [m.stepIds, m.atMs])).toEqual([
      [["s1", "s2"], 4300],
      [["s3"], 9100],
    ]);
  });
});

const post: BlogPost = {
  title: "Create a project in seconds",
  description: 'Start a project with a name, a status and an "owner".',
  tags: ["projects", "projects", " getting started "],
  intro: "Every piece of work starts as a project.",
  sections: [
    { heading: "## Open the form", body: "Click **+ New project**.", shot: 1, alt: "The new project form" },
    { heading: "Save it", body: "Click **Create project**.", shot: 1, alt: "Used twice" },
    { heading: "See it listed", body: "It is at the top of the list.", shot: 7, alt: "Not offered" },
  ],
  closing: "Now you can track your work.",
};

describe("blog post", () => {
  it("keeps only screenshots that were offered, each once", () => {
    const clean = normalizePost(post, [1, 2]);
    expect(clean.sections.map((s) => [s.heading, s.shot, s.alt])).toEqual([
      ["Open the form", 1, "The new project form"],
      ["Save it", null, null],
      ["See it listed", null, null],
    ]);
    expect(clean.tags).toEqual(["projects", "getting started"]);
  });

  it("is Markdown with front matter, the video and the screenshots next to it", () => {
    const markdown = blogMarkdown(normalizePost(post, [1, 2]), {
      base: "20261118-1-create",
      video: true,
      poster: true,
      images: new Map([[1, "20261118-1-create.blog-1.png"]]),
      date: "2026-11-18",
      cta: { text: "Try it at acme.com", url: "https://acme.com" },
    });
    expect(markdown).toBe(
      [
        "---",
        'title: "Create a project in seconds"',
        'description: "Start a project with a name, a status and an \\"owner\\"."',
        "date: 2026-11-18",
        'tags: ["projects", "getting started"]',
        'image: "20261118-1-create.png"',
        'video: "20261118-1-create.mp4"',
        "---",
        "",
        "Every piece of work starts as a project.",
        "",
        '<video src="20261118-1-create.mp4" poster="20261118-1-create.png" controls preload="metadata" playsinline></video>',
        "",
        "## Open the form",
        "",
        "Click **+ New project**.",
        "",
        "![The new project form](20261118-1-create.blog-1.png)",
        "",
        "## Save it",
        "",
        "Click **Create project**.",
        "",
        "## See it listed",
        "",
        "It is at the top of the list.",
        "",
        "Now you can track your work.",
        "",
        "[Try it at acme.com](https://acme.com)",
        "",
      ].join("\n"),
    );
  });

  it("uses the first screenshot as its image when there is no video", () => {
    const markdown = blogMarkdown(normalizePost(post, [1]), {
      base: "x",
      video: false,
      poster: false,
      images: new Map([[1, "x.blog-1.png"]]),
      date: "2026-11-18",
    });
    expect(markdown).toContain('image: "x.blog-1.png"');
    expect(markdown).not.toContain("<video");
    expect(markdown).not.toContain("video:");
  });
});
