import type { Feature, FeaturePlan } from "@demoforge/contracts";

/** Objective for one video that walks through every feature, in order. */
export function objectiveForAllFeatures(plan: Pick<FeaturePlan, "title" | "features">): string {
  if (plan.features.length === 1) return objectiveForFeature(plan.features[0] as Feature);
  const list = plan.features.map((f, i) => `${i + 1}. ${f.title}${f.details ? `: ${f.details}` : ""}`).join("\n\n");
  return [
    `Show what is new${plan.title ? ` in "${plan.title}"` : ""}: demonstrate each feature below, in this order.`,
    list,
    "Give each feature its own section, named after it. Keep each one short and verify that each feature is visible or works.",
  ].join("\n\n");
}

/** Objective for a video about a single feature. */
export function objectiveForFeature(feature: Feature): string {
  return [`Demonstrate the feature "${feature.title}".`, feature.details].filter(Boolean).join("\n\n");
}
