import type { Workflow } from "@demoforge/contracts";
import { slugify } from "@demoforge/shared";
import type { Store } from "../store/store";

/**
 * Verified click-plans, kept in the database so the next video of the same feature replays
 * them without AI planning (cheaper, faster, identical). Users never manage them: a plan
 * is saved after a successful video, reused while the feature text is unchanged, and
 * replaced automatically when the app has changed and it no longer works.
 */
export function planKey(name: string): string {
  return slugify(name, 80);
}

/** The saved plan, if there is one for exactly this objective. */
export function loadSavedPlan(store: Store, productId: string, key: string, objective: string): Workflow | undefined {
  const saved = store.getPlan(productId, planKey(key));
  // Edited release notes mean a different objective: plan again.
  return saved && saved.objective === objective ? saved.workflow : undefined;
}

export function savePlan(store: Store, productId: string, key: string, plan: Workflow): void {
  store.savePlan(productId, planKey(key), plan);
}

export function forgetPlan(store: Store, productId: string, key: string): void {
  store.deletePlan(productId, planKey(key));
}
