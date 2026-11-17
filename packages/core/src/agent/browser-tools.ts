import { z } from "zod";
import { EXPECTATION_TYPES, type Expectation, type Step, type Target } from "@app-story/contracts";
import { stripNulls, type ToolSpec } from "@app-story/ai";

/*
 * Tool input schemas. Every optional value is `.nullable()` (not `.optional()`) because
 * strict tool calling on both providers requires all properties to be present.
 */

export const TargetInput = z.object({
  role: z.string().nullable().describe("ARIA role from the snapshot, e.g. button, link, textbox, combobox, checkbox, tab, menuitem."),
  name: z.string().nullable().describe("Accessible name (visible text or label) of the element."),
  label: z.string().nullable().describe("Label of a form field."),
  text: z.string().nullable().describe("Visible text, when the element has no role/name."),
  placeholder: z.string().nullable(),
  test_id: z.string().nullable(),
  css: z.string().nullable().describe("CSS selector. Last resort only."),
  nth: z.number().int().nullable().describe("0-based index when several elements match."),
});

export const ExpectationInput = z.object({
  type: z.enum(EXPECTATION_TYPES),
  text: z.string().nullable().describe("Text for text_present / text_absent / url_contains / title_contains."),
  target: TargetInput.nullable().describe("Element for visible / hidden / value_equals / count_at_least."),
  value: z.string().nullable(),
  count: z.number().int().nullable(),
  description: z.string().describe("What this proves, in plain words."),
});

const common = {
  description: z.string().describe("Viewer-facing description of this step."),
  section: z.string().nullable().describe("Short chapter title (2-4 words)."),
};

export const RehearsalToolInputs = {
  navigate: z.object({ ...common, url: z.string().describe("Path like /projects or a full URL on an allowed domain."), expected: ExpectationInput.nullable() }),
  click: z.object({ ...common, target: TargetInput, expected: ExpectationInput.nullable() }),
  fill: z.object({
    ...common,
    target: TargetInput,
    value: z.string(),
    secret: z.boolean().nullable().describe("true when value is an {{env:NAME}} credential placeholder."),
    expected: ExpectationInput.nullable(),
  }),
  select_option: z.object({ ...common, target: TargetInput, option: z.string().describe("Visible option label."), expected: ExpectationInput.nullable() }),
  set_checkbox: z.object({ ...common, target: TargetInput, checked: z.boolean(), expected: ExpectationInput.nullable() }),
  hover: z.object({ ...common, target: TargetInput }),
  scroll: z.object({ ...common, target: TargetInput.nullable(), direction: z.enum(["up", "down"]).nullable(), amount: z.number().int().nullable() }),
  press_key: z.object({ ...common, key: z.string().describe("Key such as Enter, Escape, Tab."), expected: ExpectationInput.nullable() }),
  verify: z.object({ ...common, expectation: ExpectationInput }),
  observe_page: z.object({}),
  finish: z.object({
    title: z.string().describe("Video title, e.g. 'Creating a new project'."),
    summary: z.string().describe("One or two sentences on what the demo shows."),
    keep_step_ids: z.array(z.string()).describe("Successful step ids to replay, in execution order."),
  }),
  give_up: z.object({
    reason: z.string(),
    category: z.enum(["unsupported", "blocked_by_policy", "application_error", "authentication", "other"]),
  }),
} as const;

export type RehearsalToolName = keyof typeof RehearsalToolInputs;

const DESCRIPTIONS: Record<RehearsalToolName, string> = {
  navigate: "Go to a page of the application. Returns the new page snapshot.",
  click: "Click an element (button, link, tab, menu item...). Returns the new page snapshot.",
  fill: "Type text into a form field (replaces its content).",
  select_option: "Choose an option in a <select> dropdown.",
  set_checkbox: "Check or uncheck a checkbox or switch.",
  hover: "Move the pointer over an element, e.g. to reveal a menu.",
  scroll: "Scroll an element into view, or scroll the page up/down.",
  press_key: "Press a keyboard key on the focused element.",
  verify: "Check in the browser that an expected outcome is true. Use this to prove the objective succeeded.",
  observe_page: "Get the current page URL, title and accessibility snapshot without acting.",
  finish: "Finish the rehearsal with the clean list of steps to replay.",
  give_up: "Stop because the objective cannot be achieved safely or at all.",
};

export function rehearsalToolSpecs(): ToolSpec[] {
  return (Object.keys(RehearsalToolInputs) as RehearsalToolName[]).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: RehearsalToolInputs[name],
  }));
}

export function toTarget(input: z.infer<typeof TargetInput>): Target {
  return stripNulls(input) as Target;
}

export function toExpectation(input: z.infer<typeof ExpectationInput> | null): Expectation | undefined {
  if (!input) return undefined;
  const clean = stripNulls(input) as Expectation;
  return { ...clean, target: input.target ? toTarget(input.target) : undefined };
}

/** Convert an action tool call into a workflow step. Returns undefined for non-action tools. */
export function toolCallToStep(name: RehearsalToolName, raw: unknown, id: string): Step | undefined {
  const section = (raw as { section?: string | null }).section ?? undefined;
  switch (name) {
    case "navigate": {
      const i = RehearsalToolInputs.navigate.parse(raw);
      return { id, description: i.description, section, action: "navigate", url: i.url, expected: toExpectation(i.expected) };
    }
    case "click": {
      const i = RehearsalToolInputs.click.parse(raw);
      return { id, description: i.description, section, action: "click", target: toTarget(i.target), expected: toExpectation(i.expected) };
    }
    case "fill": {
      const i = RehearsalToolInputs.fill.parse(raw);
      return {
        id,
        description: i.description,
        section,
        action: "fill",
        target: toTarget(i.target),
        value: i.value,
        secret: i.secret ?? undefined,
        expected: toExpectation(i.expected),
      };
    }
    case "select_option": {
      const i = RehearsalToolInputs.select_option.parse(raw);
      return { id, description: i.description, section, action: "select", target: toTarget(i.target), value: i.option, expected: toExpectation(i.expected) };
    }
    case "set_checkbox": {
      const i = RehearsalToolInputs.set_checkbox.parse(raw);
      return {
        id,
        description: i.description,
        section,
        action: i.checked ? "check" : "uncheck",
        target: toTarget(i.target),
        expected: toExpectation(i.expected),
      };
    }
    case "hover": {
      const i = RehearsalToolInputs.hover.parse(raw);
      return { id, description: i.description, section, action: "hover", target: toTarget(i.target) };
    }
    case "scroll": {
      const i = RehearsalToolInputs.scroll.parse(raw);
      return {
        id,
        description: i.description,
        section,
        action: "scroll",
        target: i.target ? toTarget(i.target) : undefined,
        direction: i.direction ?? undefined,
        amount: i.amount ?? undefined,
      };
    }
    case "press_key": {
      const i = RehearsalToolInputs.press_key.parse(raw);
      return { id, description: i.description, section, action: "press", key: i.key, expected: toExpectation(i.expected) };
    }
    case "verify": {
      const i = RehearsalToolInputs.verify.parse(raw);
      return { id, description: i.description, section, action: "assert", expected: toExpectation(i.expectation) };
    }
    default:
      return undefined;
  }
}
