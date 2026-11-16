import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DemoForgeError, fileExists } from "@demoforge/shared";

export const FEATURES_FILE = "features.md";

export interface Feature {
  title: string;
  /** Everything under the feature's `##` heading: what it does, where it is, how to use it. */
  details: string;
}

/**
 * The product's feature list or changelog: the source of what a video demonstrates.
 *
 * Format: an optional `# Title` (e.g. the release name), optional intro text, then one
 * `## Feature name` section per feature. A file without `##` sections is one feature.
 */
export interface FeatureFile {
  file: string;
  title: string | undefined;
  intro: string;
  features: Feature[];
  content: string;
}

export function defaultFeaturesPath(product: { dir: string }): string {
  return join(product.dir, FEATURES_FILE);
}

export async function loadFeatures(file: string): Promise<FeatureFile> {
  if (!(await fileExists(file))) {
    throw new DemoForgeError("CONFIG_INVALID", `Feature file not found: ${file}`, {
      hint: `Create it with one "## Feature name" section per feature (see products/README.md).`,
    });
  }
  const parsed = parseFeatures(await readFile(file, "utf8"), file);
  if (parsed.features.length === 0) {
    throw new DemoForgeError("CONFIG_INVALID", `Feature file ${file} is empty.`, {
      hint: 'Describe each feature under its own "## Feature name" heading.',
    });
  }
  return parsed;
}

export function parseFeatures(text: string, file = FEATURES_FILE): FeatureFile {
  const content = text.replace(/\r\n/g, "\n");
  let title: string | undefined;
  const intro: string[] = [];
  const features: { title: string; lines: string[] }[] = [];
  let inFence = false;

  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h1 = !inFence && /^#\s+(.+?)\s*#*\s*$/.exec(line);
    const h2 = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1 && title === undefined && features.length === 0) {
      title = h1[1];
    } else if (h2) {
      features.push({ title: h2[1] as string, lines: [] });
    } else if (features.length > 0) {
      features[features.length - 1]?.lines.push(line);
    } else {
      intro.push(line);
    }
  }

  const introText = intro.join("\n").trim();
  const list: Feature[] = features.map((f) => ({ title: f.title, details: f.lines.join("\n").trim() }));
  // No `##` sections: the whole file describes a single feature.
  if (list.length === 0 && (introText || title)) {
    return { file, title, intro: "", features: [{ title: title ?? "Product update", details: introText }], content };
  }
  return { file, title, intro: introText, features: list, content };
}

/** Objective for one video that walks through every feature in the file, in order. */
export function objectiveForAllFeatures(features: FeatureFile): string {
  if (features.features.length === 1) return objectiveForFeature(features.features[0] as Feature);
  const list = features.features.map((f, i) => `${i + 1}. ${f.title}`).join("\n");
  return [
    `Show what is new${features.title ? ` in "${features.title}"` : ""}: demonstrate each feature below, in this order.`,
    list,
    `Give each feature its own section, named after it. Keep each one short and verify that each feature is visible or works. ` +
      `The feature file (${FEATURES_FILE}) in the product knowledge describes every feature in detail.`,
  ].join("\n\n");
}

/** Objective for a video about a single feature. */
export function objectiveForFeature(feature: Feature): string {
  return [`Demonstrate the feature "${feature.title}".`, feature.details].filter(Boolean).join("\n\n");
}
