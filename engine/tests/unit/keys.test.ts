import { describe, expect, it } from "vitest";
import { keyLabels } from "@app-story/video";

describe("key labels", () => {
  it("turns Playwright key names into keycaps", () => {
    expect(keyLabels("Control+K")).toEqual(["Ctrl", "K"]);
    expect(keyLabels("Meta+Shift+p")).toEqual(["⌘", "Shift", "P"]);
    expect(keyLabels("Enter")).toEqual(["Enter"]);
    expect(keyLabels("Shift+ArrowDown")).toEqual(["Shift", "↓"]);
    expect(keyLabels("Control++")).toEqual(["Ctrl", "+"]);
    expect(keyLabels("Control+KeyS")).toEqual(["Ctrl", "S"]);
  });
});
