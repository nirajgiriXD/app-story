import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { WorkflowSchema, formatZodError, type Workflow } from "@showrun/contracts";
import { ShowrunError } from "@showrun/shared";

/** Parse a workflow (a verified click-plan) from YAML. */
export function parseWorkflow(text: string, source = "workflow"): Workflow {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ShowrunError("CONFIG_INVALID", `Could not parse ${source}: ${(error as Error).message}`);
  }
  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ShowrunError("CONFIG_INVALID", `Invalid workflow in ${source}:\n${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

export function workflowToYaml(workflow: Workflow): string {
  return stringifyYaml(workflow, { lineWidth: 110 });
}
