import { describe, expect, it } from "vitest";
import { WorkflowSchema, type NarrationScript, type Workflow } from "@app-story/contracts";
import { checkTranslation, planToSave, savedScript } from "@app-story/core";
import { parseWorkflow, workflowToYaml } from "@app-story/products";

const plan: Workflow = WorkflowSchema.parse({
  workflow_version: 1,
  id: "create-project",
  title: "Create a project",
  objective: "Show how to create a project",
  steps: [
    { id: "s1", description: "Open the form", action: "click", target: { role: "link", name: "New project" } },
    { id: "s2", description: "Name it", action: "fill", target: { label: "Name" }, value: "Q3 Launch" },
    { id: "s3", description: "It is listed", action: "assert", expected: { type: "text_present", text: "Q3 Launch" } },
  ],
});
const script: NarrationScript = {
  intro: "Here is how.",
  segments: [
    { step_ids: ["s1", "s2"], text: "Open the form and {{@s2}}name it." },
    { step_ids: ["s3"], text: "There it is." },
  ],
  outro: "That's it.",
};
const german = {
  title: "Ein Projekt anlegen",
  summary: null,
  intro: "So geht's.",
  segments: ["Öffne das Formular und {{@s2}}benenne es.", "Da ist es."],
  outro: "Das war's.",
  cta: "Jetzt testen auf {host}",
  badge: null,
};

describe("narration saved in the plan file", () => {
  it("is saved with the plan, survives the YAML file, and is used again in its language", () => {
    const saved = parseWorkflow(workflowToYaml(planToSave(plan, { kind: "how-to", language: "en", script, translations: { de: german } })));
    expect(saved.kind).toBe("how-to");
    expect(saved.narration?.translations?.de?.segments).toEqual(german.segments);
    expect(savedScript(saved, "en")).toEqual(script);
    expect(savedScript(saved, "fr")).toBeUndefined();
  });

  it("is not used once the plan's steps changed", () => {
    const saved = planToSave(plan, { language: "en", script });
    const edited = {
      ...saved,
      steps: [...saved.steps, { id: "s4", description: "More", action: "assert" as const, expected: { type: "visible" as const, target: { text: "x" } } }],
    };
    expect(savedScript(edited, "en")).toBeUndefined();
  });

  it("leaves out an empty set of translations", () => {
    expect(planToSave(plan, { language: "en", script, translations: {} }).narration).not.toHaveProperty("translations");
  });
});

describe("translations", () => {
  it("must have one line per segment, and keep the address placeholder", () => {
    expect(() => checkTranslation({ ...german, segments: ["Nur eine Zeile."] }, script)).toThrow(/1 lines for 2 segments/);
    expect(checkTranslation({ ...german, cta: "Jetzt testen" }, script).cta).toBe("Jetzt testen {host}");
  });
});
