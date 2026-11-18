import type { JobMetadata } from "@app-story/contracts";
import { isAppStoryError } from "@app-story/shared";

const color = (code: number) => (text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
export const green = color(32);
export const red = color(31);
export const yellow = color(33);
export const dim = color(2);
export const bold = color(1);

export function printError(error: unknown): void {
  if (isAppStoryError(error)) {
    console.error(red(`✖ ${error.message}`));
    if (error.hint) console.error(dim(`  hint: ${error.hint}`));
  } else {
    console.error(red(`✖ ${(error as Error)?.stack ?? String(error)}`));
  }
}

const GOOD = new Set(["success", "success_with_warnings"]);

export function printJob(m: JobMetadata): void {
  if (m.status === "awaiting_approval") {
    console.log(`\n${yellow("⏸")} ${bold("awaiting approval")}  ${dim(`job ${m.job_id}`)}`);
    console.log("  Planned, not recorded. The plan is kept with the job.");
    console.log(`  Record it: npx app-story resume ${m.product_id} ${m.job_id}`);
    return;
  }
  const ok = GOOD.has(m.status);
  console.log("");
  console.log(`${ok ? green("✔") : red("✖")} ${bold(m.status.replace(/_/g, " "))}  ${dim(`job ${m.job_id}`)}`);
  if (m.ai.provider) console.log(`  AI:        ${m.ai.provider} / ${m.ai.model}${m.ai.fallback_used ? yellow(" (fallback used)") : ""}`);
  if (m.tts.provider) console.log(`  Voice:     ${m.tts.provider} / ${m.tts.voice}`);
  if (ok && m.video) console.log(`  Video:     ${m.video.path} ${dim(`(${m.video.duration_s}s)`)}`);
  if (ok) for (const extra of m.video?.extras ?? []) console.log(`  Also:      ${extra}`);
  if (m.usage && m.usage.requests > 0) {
    const cost = m.usage.estimated_cost_usd === null ? "n/a" : `$${m.usage.estimated_cost_usd.toFixed(4)}`;
    console.log(`  Tokens:    ${m.usage.input_tokens} in / ${m.usage.output_tokens} out ${dim(`(est. ${cost})`)}`);
  }
  // Failed jobs keep their scratch files (raw recording, screenshots, trace) for troubleshooting.
  if (!ok) console.log(`  Debug:     ${m.output_dir}`);
  // A plan that passed its checks was kept with the job: the next try need not plan again.
  if (!ok && m.mode !== "redo" && m.workflow_version !== null && m.status !== "unsupported_workflow") {
    console.log(`  Resume:    npx app-story resume ${m.product_id} ${m.job_id}`);
  }
  for (const w of m.warnings) console.log(yellow(`  ! ${w}`));
  for (const e of m.errors) {
    console.log(red(`  ✖ [${e.code}] ${e.message}`));
    if (e.hint) console.log(dim(`    hint: ${e.hint}`));
  }
  if (ok && m.video) console.log(dim("\n  Review the video before publishing. Nothing is published automatically."));
}

/** A plan stopped for review is the user's choice, not a failure. */
export function exitCodeFor(m: JobMetadata): number {
  return GOOD.has(m.status) || m.status === "awaiting_approval" ? 0 : 1;
}
