import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Workflow } from "@app-story/contracts";
import { workflowToYaml, type LoadedProduct } from "@app-story/products";
import { AppStoryError, ensureDir, fileExists, slugify } from "@app-story/shared";
import { validateWorkflow } from "@app-story/workflow";
import { planFromTrace } from "../import/playwright-trace";
import { planFile, planKey, plansDir } from "../pipeline/plans";

export interface ImportRequest {
  product: LoadedProduct;
  /** A Playwright trace.zip. */
  trace: string;
  /** The plan's name. Default: from the test's title. */
  name?: string;
  title?: string;
  /** Replace a saved plan of the same name. */
  force?: boolean;
}

export interface ImportResult {
  name: string;
  file: string;
  workflow: Workflow;
  notes: string[];
}

/** Save a Playwright trace as a plan of the product, after the same safety checks as any plan. */
export async function importTrace(request: ImportRequest): Promise<ImportResult> {
  const { product } = request;
  if (!(await fileExists(request.trace))) throw new AppStoryError("CONFIG_INVALID", `${request.trace} was not found.`);
  const { workflow, notes } = planFromTrace(await readFile(request.trace), { title: request.title });
  const name = planKey(request.name ?? slugify(workflow.title));
  const plan = { ...workflow, id: name };

  const validation = validateWorkflow(plan, product.config);
  if (validation.errors.length > 0) {
    throw new AppStoryError("UNSUPPORTED_WORKFLOW", `The trace cannot be used as a plan:\n- ${validation.errors.join("\n- ")}`, {
      hint: validation.errors.some((e) => /verifies nothing/.test(e))
        ? "Add an expect(...) to the test, e.g. await expect(page.getByText('Saved')).toBeVisible(), and record the trace again."
        : undefined,
    });
  }
  notes.push(...validation.warnings);

  const file = planFile(product, name);
  if (!request.force && (await fileExists(file))) {
    throw new AppStoryError("CONFIG_INVALID", `There is already a plan called '${name}' (${file}).`, {
      hint: "Pick another --name, or add --force to replace it.",
    });
  }
  await ensureDir(plansDir(product));
  const header = [
    `# A click-plan for "${name}", imported by AppStory from a Playwright trace (${basename(request.trace)}).`,
    "# Check it with `app-story test`, then make its video with `app-story replay`.",
    "",
  ].join("\n");
  await writeFile(file, header + workflowToYaml(plan));
  return { name, file, workflow: plan, notes };
}
