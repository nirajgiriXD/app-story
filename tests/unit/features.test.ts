import { describe, expect, it } from "vitest";
import { objectiveForAllFeatures, objectiveForFeature, parseFeatures } from "@demoforge/products";

describe("feature file", () => {
  it("reads a title, an intro and one feature per ## section", () => {
    const file = parseFeatures(
      [
        "# Release 2.4",
        "",
        "For admins.",
        "",
        "## Bulk export",
        "Export many rows.",
        "### Details",
        "Click Export.",
        "",
        "## Dark mode",
        "Moon icon in the top bar.",
      ].join("\r\n"),
    );
    expect(file.title).toBe("Release 2.4");
    expect(file.intro).toBe("For admins.");
    expect(file.features).toEqual([
      { title: "Bulk export", details: "Export many rows.\n### Details\nClick Export." },
      { title: "Dark mode", details: "Moon icon in the top bar." },
    ]);
  });

  it("ignores headings inside code blocks", () => {
    const file = parseFeatures("## Config\n```md\n## not a feature\n```\nDone.");
    expect(file.features.map((f) => f.title)).toEqual(["Config"]);
  });

  it("treats a file without ## sections as one feature", () => {
    const file = parseFeatures("# Bulk export\n\nExport many rows at once.");
    expect(file.features).toEqual([{ title: "Bulk export", details: "Export many rows at once." }]);
  });

  it("returns no features for an empty file", () => {
    expect(parseFeatures("   \n").features).toEqual([]);
  });

  it("builds objectives that name every feature in order", () => {
    const file = parseFeatures("# v2\n## Bulk export\nA\n## Dark mode\nB");
    const all = objectiveForAllFeatures(file);
    expect(all).toContain('"v2"');
    expect(all.indexOf("1. Bulk export")).toBeLessThan(all.indexOf("2. Dark mode"));
    expect(objectiveForFeature(file.features[1]!)).toBe('Demonstrate the feature "Dark mode".\n\nB');
  });
});
