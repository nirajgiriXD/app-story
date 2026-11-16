import { describe, expect, it } from "vitest";
import { ProductConfigSchema, WorkflowSchema, type Step } from "@showrun/contracts";
import { executeStep, runSteps, sectionsOf, validateWorkflow } from "@showrun/workflow";
import { createSilentLogger } from "@showrun/shared";
import { FakeController } from "../support/fake-controller";

const log = createSilentLogger();
const config = ProductConfigSchema.parse({
  version: 1,
  product: { id: "app", name: "App", description: "d", base_url: "http://app.test" },
  browser: { allowed_domains: ["app.test"] },
  providers: { ai: { provider: "anthropic" }, tts: { provider: "openai" } },
});

const wf = (steps: unknown[]) => WorkflowSchema.parse({ workflow_version: 1, id: "w", title: "T", objective: "O", steps });

describe("workflow validation", () => {
  it("accepts a verified, in-domain workflow", () => {
    const result = validateWorkflow(
      wf([
        { id: "a", description: "go", action: "navigate", url: "/projects" },
        { id: "b", description: "check", action: "assert", expected: { type: "text_present", text: "Projects" } },
      ]),
      config,
    );
    expect(result.errors).toEqual([]);
  });

  it("rejects off-domain navigation, destructive clicks and unverified workflows", () => {
    const result = validateWorkflow(
      wf([
        { id: "a", description: "go", action: "navigate", url: "https://evil.test/" },
        { id: "b", description: "remove it", action: "click", target: { role: "button", name: "Delete project" } },
      ]),
      config,
    );
    expect(result.errors.join("\n")).toMatch(/outside browser.allowed_domains/);
    expect(result.errors.join("\n")).toMatch(/delete action/);
    expect(result.errors.join("\n")).toMatch(/verifies nothing/);
  });

  it("warns about unmasked environment values", () => {
    const result = validateWorkflow(
      wf([
        { id: "a", description: "type", action: "fill", target: { label: "Password" }, value: "{{env:PW}}" },
        { id: "b", description: "check", action: "assert", expected: { type: "url_contains", text: "/" } },
      ]),
      config,
    );
    expect(result.warnings.join("\n")).toMatch(/secret: true/);
  });
});

describe("step execution", () => {
  const click: Step = { id: "s1", description: "create", action: "click", target: { role: "button", name: "Create project" }, expected: { type: "text_present", text: "Project created" } };

  it("passes only when the expected outcome is verified", async () => {
    const result = await executeStep(new FakeController(), click, { retries: 0, log });
    expect(result.status).toBe("passed");
    expect(result.verified).toBe(true);

    const noEffect: Step = { ...click, target: { role: "button", name: "New project" } };
    const failed = await executeStep(new FakeController(), noEffect, { retries: 0, log });
    expect(failed.status).toBe("failed");
    expect(failed.error_code).toBe("VERIFICATION_FAILED");
  });

  it("retries transient failures", async () => {
    const controller = new FakeController();
    controller.flaky.set("Create project", 1);
    const result = await executeStep(controller, click, { retries: 1, log });
    expect(result.status).toBe("passed");
    expect(result.attempts).toBe(2);
  });

  it("skips conditional steps whose condition does not hold", async () => {
    const step: Step = { ...click, when: { type: "visible", target: { name: "Cookie banner" } } };
    const result = await executeStep(new FakeController(), step, { retries: 0, log });
    expect(result.status).toBe("skipped");
  });

  it("stops at the first required failure but continues past optional ones", async () => {
    const controller = new FakeController();
    const steps: Step[] = [
      { id: "a", description: "optional", action: "click", target: { name: "Missing" }, optional: true },
      { id: "b", description: "required", action: "click", target: { name: "Also missing" } },
      { id: "c", description: "never", action: "click", target: { name: "New project" } },
    ];
    const report = await runSteps(controller, steps, { phase: "dry_run", log, retries: 0 });
    expect(report.ok).toBe(false);
    expect(report.steps.map((s) => s.status)).toEqual(["failed", "failed"]);
  });

  it("groups steps into sections", () => {
    expect(sectionsOf([{ id: "1", section: "A" }, { id: "2" }, { id: "3", section: "B" }])).toEqual([
      { title: "A", stepIds: ["1", "2"] },
      { title: "B", stepIds: ["3"] },
    ]);
  });
});
