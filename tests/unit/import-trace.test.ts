import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planFromTrace, selectorToTarget } from "@app-story/core";

describe("Playwright locators as targets", () => {
  it("carries over the locators people write", () => {
    expect(selectorToTarget('internal:role=button[name="Sign in"i]').target).toEqual({ role: "button", name: "Sign in" });
    expect(selectorToTarget('internal:role=link[name="Docs"s] >> nth=1').target).toEqual({ role: "link", name: "Docs", exact: true, nth: 1 });
    expect(selectorToTarget('internal:label="Email"i').target).toEqual({ label: "Email" });
    expect(selectorToTarget('internal:text="Q3 \\"Launch\\""s').target).toEqual({ text: 'Q3 "Launch"', exact: true });
    expect(selectorToTarget('internal:attr=[placeholder="Search"i]').target).toEqual({ placeholder: "Search" });
    expect(selectorToTarget('internal:testid=[data-testid="save"s]').target).toEqual({ test_id: "save" });
    expect(selectorToTarget("#status").target).toEqual({ css: "#status" });
  });

  it("says why a chained, combined or last-of locator cannot be used", () => {
    expect(selectorToTarget('internal:testid=[data-testid="a"s] >> internal:or="internal:role=link"').problem).toMatch(/chained or combined/);
    expect(selectorToTarget('internal:role=row >> internal:has-text="Bob"i').problem).toMatch(/chained or combined/);
    expect(selectorToTarget("internal:role=listitem >> nth=-1").problem).toMatch(/last/);
    expect(selectorToTarget("internal:role=checkbox[checked=true]").problem).toMatch(/role option/);
  });
});

describe("importing a Playwright trace", () => {
  it("turns a real test's trace into a plan, without its login or its password", async () => {
    // Recorded with Playwright 1.65.1 from a test of the practice app (tests/example-app).
    const { workflow, notes } = planFromTrace(await readFile("tests/fixtures/playwright-trace.zip"));
    expect(workflow.title).toBe("Create a project");
    expect(workflow.objective).toBe("Show how to create a project");
    expect(workflow.steps.map((s) => [s.action, s.description])).toEqual([
      ["assert", "Check that Projects is visible"],
      ["click", 'Click "+ New project"'],
      ["assert", "Check that the address contains projects/new"],
      ["fill", 'Type into "Project name"'],
      ["fill", 'Type into "What is this project about?"'],
      ["select", 'Choose "In progress" in "#status"'],
      ["click", 'Click "Create project"'],
      ["assert", 'Check that the page shows "Q3 Product Launch"'],
      ["press", "Press Control+K"],
      ["assert", "Check that Q3 Product Launch is visible"],
    ]);
    expect(workflow.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]);
    expect(workflow.steps[9]?.expected?.target).toEqual({ text: "Q3 Product Launch", nth: 0 });
    expect(JSON.stringify(workflow)).not.toContain("demo1234");
    expect(notes.join("\n")).toMatch(/Left out the test's login \(4 step/);
    expect(notes.join("\n")).toMatch(/chained or combined locator/); // the .or() hover
  });

  it("refuses a file that is not a trace", () => {
    expect(() => planFromTrace(Buffer.from("not a zip"))).toThrow(/not a zip/);
  });
});
