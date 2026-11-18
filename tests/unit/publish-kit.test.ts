import { describe, expect, it } from "vitest";
import { videoDescription } from "@app-story/core";
import { parseProductFile } from "@app-story/products";
import { chaptersOf, ffmetadata, youtubeChapters, type RenderProps } from "@app-story/video";

const video = (sections: { title: string; atMs: number }[], durationMs = 60_000) =>
  ({
    title: "Export invoices in bulk",
    sections,
    recording: { startMs: 2700 },
    durationMs,
    brand: { host: "acme.com", cta: "Start free at {host}" },
  }) as unknown as RenderProps;

describe("chapters", () => {
  it("are the title card, then each section, merging ones too close to jump to", () => {
    const chapters = chaptersOf(
      video([
        { title: "Open reports", atMs: 300 },
        { title: "Pick invoices", atMs: 9_000 },
        { title: "Export", atMs: 10_500 },
        { title: "The result", atMs: 30_000 },
      ]),
    );
    // "Open reports" starts with the recording, too close to the title card to be a chapter of its own.
    expect(chapters).toEqual([
      { startMs: 0, title: "Export invoices in bulk" },
      { startMs: 11_700, title: "Export" },
      { startMs: 32_700, title: "The result" },
    ]);
  });

  it("are written for FFmpeg, ending where the next begins", () => {
    const text = ffmetadata(
      [
        { startMs: 0, title: "Intro; part=1" },
        { startMs: 5000, title: "Save" },
      ],
      9000,
    );
    expect(text).toBe(
      ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=5000\ntitle=Intro\\; part\\=1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=9000\ntitle=Save\n",
    );
  });

  it("become YouTube lines only when YouTube would show them", () => {
    const three = [
      { startMs: 0, title: "Intro" },
      { startMs: 12_000, title: "Create" },
      { startMs: 75_000, title: "Result" },
    ];
    expect(youtubeChapters(three, 90_000)).toEqual(["0:00 Intro", "0:12 Create", "1:15 Result"]);
    expect(youtubeChapters(three.slice(0, 2), 90_000)).toEqual([]); // fewer than three
    expect(youtubeChapters(three, 80_000)).toEqual([]); // the last is shorter than ten seconds
  });
});

describe("description", () => {
  it("has the title, summary, chapters and where to try it", () => {
    const { config, brief } = parseProductFile("---\nurl: https://staging.acme.test\nwebsite: https://acme.com\n---\n# Acme\n", "acme.md", "acme");
    const product = { id: "acme", file: "acme.md", dir: ".", config, brief };
    const props = video(
      [
        { title: "Open reports", atMs: 12_000 },
        { title: "The result", atMs: 40_000 },
      ],
      70_000,
    );
    expect(videoDescription(product, { title: "Export invoices in bulk", summary: "Download many invoices as one CSV." }, props)).toBe(
      [
        "Export invoices in bulk",
        "Download many invoices as one CSV.",
        "Chapters\n0:00 Export invoices in bulk\n0:14 Open reports\n0:42 The result",
        "Start free at acme.com: https://acme.com",
      ].join("\n\n") + "\n",
    );
  });
});
