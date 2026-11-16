import type { JobMetadata } from "@demoforge/contracts";
import { isDemoForgeError } from "@demoforge/shared";

const color = (code: number) => (text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
export const green = color(32);
export const red = color(31);
export const yellow = color(33);
export const dim = color(2);
export const bold = color(1);

export function printError(error: unknown): void {
  if (isDemoForgeError(error)) {
    console.error(red(`✖ ${error.message}`));
    if (error.hint) console.error(dim(`  hint: ${error.hint}`));
  } else {
    console.error(red(`✖ ${(error as Error)?.stack ?? String(error)}`));
  }
}

const GOOD = new Set(["success", "success_with_warnings"]);

export function printJob(m: JobMetadata): void {
  const ok = GOOD.has(m.status);
  console.log("");
  console.log(`${ok ? green("✔") : red("✖")} ${bold(m.status.replace(/_/g, " "))}  ${dim(`job ${m.job_id}`)}`);
  if (m.ai.provider) console.log(`  AI:        ${m.ai.provider} / ${m.ai.model}${m.ai.fallback_used ? yellow(" (fallback used)") : ""}`);
  if (m.tts.provider) console.log(`  Voice:     ${m.tts.provider} / ${m.tts.voice}`);
  if (ok && m.video) console.log(`  Video:     ${m.video.path} ${dim(`(${m.video.duration_s}s)`)}`);
  if (m.usage && m.usage.requests > 0) {
    const cost = m.usage.estimated_cost_usd === null ? "n/a" : `$${m.usage.estimated_cost_usd.toFixed(4)}`;
    console.log(`  Tokens:    ${m.usage.input_tokens} in / ${m.usage.output_tokens} out ${dim(`(est. ${cost})`)}`);
  }
  // Failed jobs keep their scratch files (raw recording, screenshots, trace) for troubleshooting.
  if (!ok) console.log(`  Debug:     ${m.output_dir}`);
  for (const w of m.warnings) console.log(yellow(`  ! ${w}`));
  for (const e of m.errors) {
    console.log(red(`  ✖ [${e.code}] ${e.message}`));
    if (e.hint) console.log(dim(`    hint: ${e.hint}`));
  }
  if (ok && m.video) console.log(dim("\n  Review the video before publishing. Nothing is published automatically."));
}

export function exitCodeFor(m: JobMetadata): number {
  return GOOD.has(m.status) ? 0 : 1;
}
