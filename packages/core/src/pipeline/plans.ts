import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowSchema, type Workflow } from "@app-story/contracts";
import { parseWorkflow, workflowToYaml, type LoadedProduct } from "@app-story/products";
import { AppStoryError, ensureDir, fileExists, redactSecrets, slugify } from "@app-story/shared";

import type { Store } from "../store/store";

/**
 * Verified click-plans, saved as YAML files next to the product file
 * (`apps/<product>.plans/<name>.yaml`), so they can be committed, reviewed in a pull
 * request and shared: every copy of the project replays the same clicks. The next video
 * of the same feature replays its plan without AI planning (cheaper, faster, identical).
 * A plan is saved after a successful video, reused while the feature text is unchanged,
 * and replaced automatically when the app has changed and it no longer works. Deleting
 * the file makes the next video plan again.
 */
export function planKey(name: string): string {
  return slugify(name, 80);
}

/** The folder of a product's saved plans. */
export function plansDir(product: LoadedProduct): string {
  return join(product.dir, `${product.id}.plans`);
}

export function planFile(product: LoadedProduct, name: string): string {
  return join(plansDir(product), `${planKey(name)}.yaml`);
}

/** The saved plan, if there is one for exactly this objective. A broken file is an error, not a silent re-plan. */
export async function loadSavedPlan(store: Store, product: LoadedProduct, name: string, objective: string): Promise<Workflow | undefined> {
  const file = planFile(product, name);
  let saved: Workflow | undefined;
  if (await fileExists(file)) {
    saved = parseWorkflow(await readFile(file, "utf8"), file);
  } else {
    // Older versions kept plans in the database: move this one to its file.
    saved = store.takeLegacyPlan(product.id, planKey(name));
    if (saved) await savePlan(product, name, saved);
  }
  // Edited release notes mean a different objective: plan again.
  return saved && saved.objective === objective ? saved : undefined;
}

/** Save a plan to its file. A file that already says the same is left untouched. */
export async function savePlan(product: LoadedProduct, name: string, plan: Workflow): Promise<string> {
  const file = planFile(product, name);
  await ensureDir(plansDir(product));
  const header = [
    `# A verified click-plan for "${planKey(name)}", saved by AppStory after a successful video.`,
    "# The next video of this feature replays it without AI planning (and, with its narration, without any AI).",
    "# Delete this file to plan again.",
    "",
  ].join("\n");
  // Parsed first, so the fields are always in the same order: an unchanged plan writes the same text.
  const text = header + workflowToYaml(redactSecrets(WorkflowSchema.parse(plan)));
  const before = await readFile(file, "utf8").catch(() => undefined);
  if (before !== text) await writeFile(file, text);
  return file;
}

/** A product's saved plans, by name (the file name without `.yaml`), sorted. */
export async function listPlans(product: LoadedProduct): Promise<{ name: string; file: string }[]> {
  const files = await readdir(plansDir(product)).catch(() => [] as string[]);
  return files
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("."))
    .sort()
    .map((f) => ({ name: f.slice(0, -".yaml".length), file: join(plansDir(product), f) }));
}

/** Read a saved plan by name. */
export async function readPlan(product: LoadedProduct, name: string): Promise<Workflow> {
  const file = planFile(product, name);
  if (!(await fileExists(file))) {
    const names = (await listPlans(product)).map((p) => p.name);
    throw new AppStoryError("CONFIG_INVALID", `There is no saved plan '${name}' for ${product.id} (looked for ${file}).`, {
      hint: names.length
        ? `Saved plans: ${names.join(", ")}`
        : `Make a video first (npx app-story ${product.id}), or import one: npx app-story import ${product.id} <trace.zip>`,
    });
  }
  return parseWorkflow(await readFile(file, "utf8"), file);
}

export async function forgetPlan(product: LoadedProduct, name: string): Promise<void> {
  await rm(planFile(product, name), { force: true });
}

export async function countPlans(product: LoadedProduct): Promise<number> {
  const files = await readdir(plansDir(product)).catch(() => []);
  return files.filter((f) => f.endsWith(".yaml")).length;
}
