import { Command } from "commander";
import { testPlans } from "@app-story/core";
import { globals, openProduct } from "../context";
import { bold, dim, green, red } from "../output";

export function testCommand(): Command {
  return new Command("test")
    .description("Check that saved plans still work in the app (fast: no recording, voice or AI)")
    .argument("<product>", "product name")
    .argument("[plans...]", "plan names from products/<product>.plans/ (default: all of them)")
    .option("--headed", "show the browser window while working")
    .addHelpText(
      "after",
      `
Every step of each saved plan is replayed at full speed and every expected outcome is
checked, so a demo doubles as a test: when the app changes, you learn which step broke
before the video goes stale. Exits with 1 if any plan fails.

Examples:
  npx app-story test acme                    every saved plan of acme
  npx app-story test acme bulk-export        one plan`,
    )
    .action(async (productId: string, names: string[], opts: { headed?: boolean }, cmd: Command) => {
      const { outputDir, logLevel } = globals(cmd);
      const product = await openProduct(productId);
      const checks = await testPlans({
        product,
        outputDir,
        names,
        logLevel,
        headless: opts.headed ? false : undefined,
        onPlan: (c) => {
          const time = dim(`(${(c.durationMs / 1000).toFixed(1)}s, ${c.steps.length} steps)`);
          console.log(`${c.ok ? green("✔") : red("✖")} ${bold(c.name)} ${time}`);
          for (const p of c.problems) console.log(red(`    ${p}`));
          if (c.screenshot) console.log(dim(`    screenshot: ${c.screenshot}`));
        },
      });
      const failed = checks.filter((c) => !c.ok).length;
      console.log(failed ? red(`\n${failed} of ${checks.length} plan(s) failed.`) : green(`\nAll ${checks.length} plan(s) work.`));
      process.exitCode = failed ? 1 : 0;
    });
}
