import { describe, expect, it } from "vitest";
import type { Step, StepResult } from "@app-story/contracts";
import { parseProductFile } from "@app-story/products";
import { buildRenderProps, getTemplate, planTimeline, type BuildPropsInput } from "@app-story/video";

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
