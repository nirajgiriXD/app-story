import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Workflow } from "@demoforge/contracts";
import { parseWorkflow, workflowToYaml } from "@demoforge/products";
import { slugify } from "@demoforge/shared";

/**
 * Verified click-plans, kept so the next video of the same feature replays them without
 * AI planning (cheaper, faster, identical). Users never manage these files: a plan is
 * saved after a successful video, reused while the feature text is unchanged, and
 * replaced automatically when the app has changed and it no longer works.
 */
export function savedPlanFile(outputDir: string, productId: string, key: string): string {
  return join(outputDir, ".plans", productId, `${slugify(key, 80)}.yaml`);
}

/** The saved plan, if there is one for exactly this objective. */
export async function loadSavedPlan(file: string, objective: string): Promise<Workflow | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (!text) return undefined;
  try {
    const plan = parseWorkflow(text, file);
    // Edited release notes mean a different objective: plan again.
    return plan.objective === objective ? plan : undefined;
  } catch {
    return undefined;
  }
}

export async function savePlan(file: string, plan: Workflow): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, workflowToYaml(plan), "utf8");
}

export async function forgetPlan(file: string): Promise<void> {
  await rm(file, { force: true });
}
