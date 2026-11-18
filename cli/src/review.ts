import { createInterface } from "node:readline/promises";
import type { PlanReview } from "@app-story/core";
import { AppStoryError, serialQueue } from "@app-story/shared";
import { bold, dim, green } from "./output";

/**
 * `--review`: show each newly planned video as numbered steps and ask before it is narrated
 * and recorded. Two videos are made at a time, so the questions take turns.
 */
export function terminalReviewer(): (review: PlanReview) => Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AppStoryError("CONFIG_INVALID", "--review asks in the terminal, and there is none here (CI or a script).", {
      hint: "Run it in a terminal, or leave out --review.",
    });
  }
  const queue = serialQueue();
  return (review) => queue(() => ask(review));
}

async function ask({ workflow, name }: PlanReview): Promise<boolean> {
  const lines = workflow.steps.map((step, i) => {
    const check = step.action === "assert" ? green("✓ ") : "";
    const section = step.section ? dim(`  [${step.section}]`) : "";
    return `  ${String(i + 1).padStart(2)}. ${check}${step.description}${section}`;
  });
  console.log(`\n${bold(`Planned "${name}"`)} ${dim(`(${workflow.steps.length} steps)`)}: ${workflow.title}`);
  console.log(lines.join("\n"));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`Record this video? ${bold("[Y]es")} / [n]o, stop for now: `)).trim().toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
    }
  } finally {
    rl.close();
  }
}
