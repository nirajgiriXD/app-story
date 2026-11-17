import { StepSchema, formatZodError, type ExecutionReport, type Step, type StepResult, type VideoKind, type Workflow } from "@app-story/contracts";
import type { BrowserController, PageObservation } from "@app-story/browser";
import { assembleWorkflow, executeStep } from "@app-story/workflow";
import type { Logger } from "@app-story/shared";
import { PHASE_EFFORT, formatProductContext, loadPrompt, runToolLoop, untrusted, type AIProvider, type ProductContext, type ToolHandler } from "@app-story/ai";
import { RehearsalToolInputs, rehearsalToolSpecs, toolCallToStep, type RehearsalToolName } from "./browser-tools";

export interface RehearsalInput {
  provider: AIProvider;
  controller: BrowserController;
  product: ProductContext;
  objective: string;
  audience?: string;
  kind?: VideoKind;
  /** The longest the video should be. */
  targetDurationS: number;
  maxIterations: number;
  maxDurationS: number;
  log: Logger;
  screenshotDir?: string;
  jobId?: string;
}

export type RehearsalOutcome =
  | { status: "success"; workflow: Workflow; report: ExecutionReport; iterations: number }
  | {
      status: "gave_up";
      category: "unsupported" | "blocked_by_policy" | "application_error" | "authentication" | "other";
      reason: string;
      report: ExecutionReport;
      iterations: number;
    }
  | { status: "incomplete"; reason: string; report: ExecutionReport; iterations: number };

const KIND_LABEL: Record<VideoKind, string> = {
  "whats-new": "What's new: a tour of each new feature in this release.",
  feature: "Feature spotlight: one feature, shown end to end.",
  "how-to": "How-to: a task the viewer should be able to repeat on their own.",
};

interface Executed {
  step: Step;
  result: StepResult;
  order: number;
}

async function describePage(controller: BrowserController): Promise<string> {
  const obs = await controller.observe();
  return `URL: ${obs.url}\nTitle: ${obs.title}\n${untrusted(obs.snapshot)}${offLimitsNote(obs.offLimits)}`;
}

/**
 * Written by AppStory, outside the page's content: the elements on this page that the
 * safety policy will refuse, so the planner does not spend a turn finding out.
 */
export function offLimitsNote(elements: PageObservation["offLimits"]): string {
  if (!elements?.length) return "";
  const list = elements.map((e) => `- ${e.role} "${e.name}" (${e.category.replace(/_/g, " ")})`).join("\n");
  return `\n\nAppStory's safety policy refuses these elements on this page; do not use them:\n${list}`;
}

/**
 * The practice run: the AI drives the real browser through guarded tools, then hands back
 * the subset of successful steps that forms a clean, verified, replayable workflow.
 */
export async function runRehearsal(input: RehearsalInput): Promise<RehearsalOutcome> {
  const { controller, log } = input;
  const startedAt = Date.now();
  const executed = new Map<string, Executed>();
  let counter = 0;
  let outcome: RehearsalOutcome | undefined;

  const report = (ok: boolean): ExecutionReport => ({
    phase: "rehearsal",
    ok,
    steps: [...executed.values()].map((e) => e.result),
    cursor: [],
    issues: [...controller.issues],
    final_url: controller.currentUrl(),
    duration_ms: Date.now() - startedAt,
  });

  const actionHandler = (name: RehearsalToolName): ToolHandler => ({
    schema: RehearsalToolInputs[name],
    async run(raw, _call, { last }) {
      counter += 1;
      const candidate = toolCallToStep(name, raw, `r${counter}`);
      if (!candidate) return { content: `Tool ${name} is not an action.`, isError: true };
      // Validate against the workflow contract before touching the browser.
      const checked = StepSchema.safeParse(candidate);
      if (!checked.success) {
        return { content: `Invalid step, nothing was done:\n${formatZodError(checked.error)}`, isError: true };
      }
      const step = checked.data;
      const result = await executeStep(controller, step, { retries: 0, log, screenshotDir: input.screenshotDir });
      executed.set(step.id, { step, result, order: counter });
      const passed = result.status === "passed";
      // The page snapshot is the biggest part of the conversation: send it once per turn
      // (after the last action), or when something failed and the model must look again.
      const page = passed && !last ? "" : `\n${await describePage(controller).catch(() => "(page snapshot unavailable)")}`;
      if (passed) {
        return { content: `OK — step ${step.id} succeeded${step.expected ? " and its expected outcome was verified" : ""}.${page}` };
      }
      return { content: `FAILED — step ${step.id}: ${result.error} [${result.error_code}]${page}`, isError: true };
    },
  });

  const handlers: Record<string, ToolHandler> = {
    observe_page: { schema: RehearsalToolInputs.observe_page, run: async () => ({ content: await describePage(controller) }) },
    give_up: {
      schema: RehearsalToolInputs.give_up,
      async run(raw) {
        const i = RehearsalToolInputs.give_up.parse(raw);
        outcome = { status: "gave_up", category: i.category, reason: i.reason, report: report(false), iterations: 0 };
        return { content: "Understood.", done: true };
      },
    },
    finish: {
      schema: RehearsalToolInputs.finish,
      async run(raw) {
        const i = RehearsalToolInputs.finish.parse(raw);
        const problems = checkKeptSteps(i.keep_step_ids, executed);
        if (problems.length > 0) {
          return { content: `Cannot finish yet:\n- ${problems.join("\n- ")}\nFix this, then call finish again.`, isError: true };
        }
        const kept = i.keep_step_ids.map((id) => (executed.get(id) as Executed).step);
        let section: string | undefined;
        const steps = kept.map((s) => {
          section = s.section ?? section;
          return { ...s, section };
        });
        const workflow = assembleWorkflow({
          title: i.title,
          summary: i.summary,
          objective: input.objective,
          audience: input.audience,
          steps,
          createdBy: "ai",
          source: { provider: input.provider.name, model: input.provider.model, job_id: input.jobId, created_at: new Date().toISOString() },
        });
        outcome = { status: "success", workflow, report: report(true), iterations: 0 };
        return { content: "Rehearsal accepted.", done: true };
      },
    },
  };
  for (const name of ["navigate", "click", "fill", "select_option", "set_checkbox", "hover", "scroll", "press_key", "verify"] as const) {
    handlers[name] = actionHandler(name);
  }

  const session = input.provider.startAgentSession({ system: loadPrompt("rehearsal"), tools: rehearsalToolSpecs(), effort: PHASE_EFFORT.rehearsal });
  const firstMessage = [
    formatProductContext(input.product),
    `# Demonstration objective\n${input.objective}`,
    input.audience ? `# Audience\n${input.audience}` : "",
    input.kind ? `# Kind of video\n${KIND_LABEL[input.kind]}` : "",
    `# Video length\nAt most ${input.targetDurationS} seconds, so keep the demo focused (typically 4–12 steps).`,
    `# Current page\n${await describePage(controller)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const loop = await runToolLoop(session, firstMessage, handlers, {
    maxIterations: input.maxIterations,
    deadline: startedAt + input.maxDurationS * 1000,
    log,
    nudge: "Continue with the tools. Call `finish` when the objective is verified, or `give_up` if it cannot be done.",
  });

  if (outcome) return { ...outcome, iterations: loop.iterations };
  return {
    status: "incomplete",
    reason: loop.finished ? "The agent stopped without a result." : `The agent did not finish within ${input.maxIterations} iterations.`,
    report: report(false),
    iterations: loop.iterations,
  };
}

function checkKeptSteps(ids: string[], executed: Map<string, Executed>): string[] {
  const problems: string[] = [];
  if (ids.length === 0) return ["keep_step_ids is empty."];
  let lastOrder = 0;
  const seen = new Set<string>();
  for (const id of ids) {
    const e = executed.get(id);
    if (!e) {
      problems.push(`${id} is not a step you executed.`);
      continue;
    }
    if (seen.has(id)) problems.push(`${id} is listed twice.`);
    seen.add(id);
    if (e.result.status !== "passed") problems.push(`${id} did not succeed, so it cannot be replayed.`);
    if (e.order < lastOrder) problems.push(`${id} is out of execution order.`);
    lastOrder = e.order;
  }
  const verified = ids.some((id) => {
    const e = executed.get(id);
    return e && e.result.status === "passed" && (e.step.action === "assert" || e.step.expected);
  });
  if (!verified) problems.push("No kept step verifies the outcome. Call `verify` to prove the objective succeeded and keep that step.");
  return problems;
}
