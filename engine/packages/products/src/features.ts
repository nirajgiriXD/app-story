import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Feature, FeaturePlan } from "@demoforge/contracts";
import { DemoForgeError, fileExists } from "@demoforge/shared";

export const FEATURES_FILE = "features.md";

/**
 * Release notes, a changelog or a feature list, in any format. The AI reads it to pick
 * what to demo (see `readReleaseNotes`), and the demo agent gets it as product knowledge.
 */
export interface ReleaseNotes {
  file: string;
  content: string;
}

export function defaultFeaturesPath(product: { dir: string }): string {
  return join(product.dir, FEATURES_FILE);
}

/**
 * Read a release-notes file; `undefined` when it is missing or has no text.
 * `<!-- ... -->` notes are left out, so the instructions in a new file are not mistaken for features.
 */
export async function readReleaseNotesFile(file: string): Promise<ReleaseNotes | undefined> {
  if (!(await fileExists(file))) return undefined;
  const content = (await readFile(file, "utf8"))
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    .trim();
  return content ? { file, content: `${content}\n` } : undefined;
}

/** Like `readReleaseNotesFile`, but a missing or empty file is an error. */
export async function loadReleaseNotes(file: string): Promise<ReleaseNotes> {
  const notes = await readReleaseNotesFile(file);
  if (!notes) {
    throw new DemoForgeError("CONFIG_INVALID", `No release notes found in ${file}.`, {
      hint: "Paste your release notes or changelog into it, in any format (see products/README.md).",
    });
  }
  return notes;
}

/** Objective for one video that walks through every feature, in order. */
export function objectiveForAllFeatures(plan: Pick<FeaturePlan, "title" | "features">): string {
  if (plan.features.length === 1) return objectiveForFeature(plan.features[0] as Feature);
  const list = plan.features.map((f, i) => `${i + 1}. ${f.title}${f.details ? `: ${f.details}` : ""}`).join("\n\n");
  return [
    `Show what is new${plan.title ? ` in "${plan.title}"` : ""}: demonstrate each feature below, in this order.`,
    list,
    "Give each feature its own section, named after it. Keep each one short and verify that each feature is visible or works. " +
      `The release notes (${FEATURES_FILE}) in the product knowledge have more detail.`,
  ].join("\n\n");
}

/** Objective for a video about a single feature. */
export function objectiveForFeature(feature: Feature): string {
  return [`Demonstrate the feature "${feature.title}".`, feature.details].filter(Boolean).join("\n\n");
}
