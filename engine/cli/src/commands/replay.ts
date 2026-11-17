import { Command } from "commander";
import { replayPlans } from "@app-story/core";
import { globals, openProduct } from "../context";
import { dim, exitCodeFor, printJob } from "../output";

export function replayCommand(): Command {
  return new Command("replay")
    .description("Make the videos of saved plans again, exactly as planned (no AI once a plan has its narration)")
    .argument("<product>", "product name")
    .argument("[plans...]", "plan names from products/<product>.plans/ (default: all of them)")
    .option("--headed", "show the browser window while working")
    .addHelpText(
      "after",
      `
Each saved plan (products/<product>.plans/<name>.yaml) is replayed in the app and
recorded, with the narration saved in it: the same video every time, with no AI, so it
runs in CI without a key. A plan that no longer works fails instead of being planned
again. A plan without narration yet (an imported one) gets it from the AI once, and it
is saved in the plan: commit the file.

Examples:
  npx app-story replay acme                  every saved plan of acme
  npx app-story replay acme bulk-export      one plan`,
    )
    .action(async (productId: string, names: string[], opts: { headed?: boolean }, cmd: Command) => {
      const { outputDir, logLevel } = globals(cmd);
      const product = await openProduct(productId);
      const results = await replayPlans({
        product,
        outputDir,
        names,
        logLevel,
        headless: opts.headed ? false : undefined,
        onJobCreated: (name, j) => console.log(dim(`Replaying "${name}" → ${j.paths.root}`)),
      });
      results.forEach(printJob);
      process.exitCode = results.every((m) => exitCodeFor(m) === 0) ? 0 : 1;
    });
}
