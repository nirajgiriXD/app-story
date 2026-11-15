import { Command } from "commander";
import { dryRun } from "@demoforge/core";
import { DemoForgeError } from "@demoforge/shared";
import { globals, openProduct, type ProviderFlags } from "../context";
import { dim, exitCodeFor, green, printJob, red, yellow } from "../output";
import { providerFlags } from "./generate";

interface RunOptions extends ProviderFlags {
  product: string;
  scenario?: string;
  objective?: string;
  dryRun?: boolean;
  headed?: boolean;
}

export function runCommand(): Command {
  const cmd = new Command("run")
    .description("Run a workflow in the browser without producing a video")
    .requiredOption("--product <id>", "product id")
    .option("--scenario <id>", "scenario to replay")
    .option("--objective <text>", "objective for the AI to plan (rehearsal only)")
    .option("--dry-run", "preview only: no narration, recording or rendering (default)", true)
    .option("--headed", "show the browser window");
  providerFlags(cmd);

  return cmd.action(async (opts: RunOptions, command: Command) => {
    if (!opts.scenario === !opts.objective) throw new DemoForgeError("CONFIG_INVALID", "Use exactly one of --scenario or --objective.");
    const { outputDir, logLevel } = globals(command);
    const product = await openProduct(command, opts.product, opts);
    const result = await dryRun({
      product,
      outputDir,
      logLevel,
      scenarioId: opts.scenario,
      objective: opts.objective,
      headless: opts.headed ? false : undefined,
      onJobCreated: (job) => console.log(dim(`Job ${job.id} → ${job.paths.root}`)),
    });
    if (result.workflow) {
      console.log(`\nWorkflow: ${result.workflow.title} (${result.workflow.steps.length} steps)`);
      const results = new Map(result.report?.steps.map((s) => [s.step_id, s]));
      for (const step of result.workflow.steps) {
        const r = results.get(step.id);
        const icon = !r ? dim("·") : r.status === "passed" ? green("✔") : r.status === "skipped" ? yellow("↷") : red("✖");
        console.log(`  ${icon} ${step.id}  ${step.description}${r?.error ? red(`  — ${r.error}`) : ""}`);
      }
      for (const e of result.validation?.errors ?? []) console.log(red(`  ✖ ${e}`));
    }
    printJob(result.metadata);
    process.exitCode = exitCodeFor(result.metadata);
  });
}
