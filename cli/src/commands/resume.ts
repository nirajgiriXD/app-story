import { Command } from "commander";
import { resumeDemo } from "@app-story/core";
import { globals, openProduct, shared, withLookOptions, type LookOptions } from "../context";
import { dim, exitCodeFor, printJob } from "../output";

export function resumeCommand(): Command {
  return withLookOptions(new Command("resume"))
    .description("Finish a failed video, or record one stopped by --review, without planning it again (no AI planning cost)")
    .argument("<product>", "product name")
    .argument("[video]", "the failed video's id from `history` (default: the newest failed one)")
    .option("--headed", "show the browser window while working")
    .addHelpText(
      "after",
      `
A video that failed while rendering is rendered again from its kept recording.
One that failed earlier replays the plan the AI already made: the voice comes from
the cache and the app is recorded again. One that failed before it had a plan
cannot be resumed; make it again instead.

Examples:
  app-story resume acme                          the newest failed acme video
  app-story resume acme 20261116-134205-a1b2c3   a particular one`,
    )
    .action(async (productId: string, jobId: string | undefined, opts: { headed?: boolean } & LookOptions, cmd: Command) => {
      const { outputDir, logLevel } = globals(cmd);
      opts = shared(opts, cmd);
      const product = await openProduct(productId, opts);
      const metadata = await resumeDemo({
        product,
        outputDir,
        jobId,
        logLevel,
        headless: opts.headed ? false : undefined,
        onJobCreated: (j) => console.log(dim(`Resuming → ${j.paths.root}`)),
      });
      printJob(metadata);
      process.exitCode = exitCodeFor(metadata);
    });
}
