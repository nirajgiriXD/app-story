import { Command } from "commander";
import { discoverProduct } from "@demoforge/core";
import { globals, openProduct, type ProviderFlags } from "../context";
import { bold, dim, exitCodeFor, green, printJob } from "../output";
import { providerFlags } from "./generate";

export function discoverCommand(): Command {
  const cmd = new Command("discover")
    .description("Explore the application read-only and suggest demos to create")
    .requiredOption("--product <id>", "product id")
    .option("--max-pages <n>", "maximum pages to visit", "12")
    .option("--headed", "show the browser window");
  providerFlags(cmd);

  return cmd.action(async (opts: ProviderFlags & { product: string; maxPages: string; headed?: boolean }, command: Command) => {
    const { outputDir, logLevel } = globals(command);
    const product = await openProduct(command, opts.product, opts);
    const result = await discoverProduct({
      product,
      outputDir,
      logLevel,
      maxPages: Number(opts.maxPages),
      headless: opts.headed ? false : undefined,
      onJobCreated: (job) => console.log(dim(`Job ${job.id} → ${job.paths.root}`)),
    });
    if (result.report) {
      console.log(`\n${bold("Proposed demos")} ${dim("(review before using)")}`);
      for (const s of result.report.proposed_scenarios) console.log(`  ${green("•")} ${s.title} ${dim(`— ${s.objective}`)}`);
      console.log(dim(`\nFull report: ${result.reportFile}`));
    }
    printJob(result.metadata);
    process.exitCode = exitCodeFor(result.metadata);
  });
}
