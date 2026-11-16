import { WORKFLOW_VERSION, WorkflowSchema, formatZodError, type Step, type Workflow } from "@showrun/contracts";
import { ShowrunError, slugify } from "@showrun/shared";

export interface AssembleInput {
  title: string;
  objective: string;
  audience?: string;
  summary?: string;
  steps: Step[];
  source?: Workflow["source"];
  createdBy: "ai" | "human";
  id?: string;
}

/**
 * Turn an ordered list of verified steps into a versioned workflow document.
 * Step ids are renumbered so saved scenarios read cleanly.
 */
export function assembleWorkflow(input: AssembleInput): Workflow {
  const steps = input.steps.map((step, i) => ({ ...step, id: `s${i + 1}` }));
  const candidate = {
    workflow_version: WORKFLOW_VERSION,
    id: input.id ?? slugify(input.title),
    title: input.title,
    objective: input.objective,
    audience: input.audience,
    summary: input.summary,
    approved: false,
    created_by: input.createdBy,
    source: input.source,
    setup: [],
    steps,
    cleanup: [],
  };
  const parsed = WorkflowSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ShowrunError("PROVIDER_INVALID_OUTPUT", `The planned workflow is invalid:\n${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

/** Group consecutive steps by section title, preserving order. */
export function sectionsOf(steps: readonly Pick<Step, "id" | "section">[]): { title: string; stepIds: string[] }[] {
  const out: { title: string; stepIds: string[] }[] = [];
  for (const step of steps) {
    const title = step.section ?? out[out.length - 1]?.title ?? "Overview";
    const current = out[out.length - 1];
    if (current && current.title === title) current.stepIds.push(step.id);
    else out.push({ title, stepIds: [step.id] });
  }
  return out;
}
