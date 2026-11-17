import { Command } from "commander";
import { importTrace } from "@app-story/core";
import { openProduct } from "../context";
import { bold, dim, green, yellow } from "../output";

export function importCommand(): Command {
  return new Command("import")
    .description("Turn a Playwright trace into a saved plan (no AI)")
    .argument("<product>", "product name")
    .argument("<trace>", "a trace.zip from `npx playwright test --trace on` (in test-results/)")
    .option("--name <name>", "the plan's name (default: from the test's title)")
    .option("--title <title>", "the video's title (default: the test's title)")
    .option("--force", "replace a saved plan of the same name")
    .addHelpText(
      "after",
      `
Your Playwright tests already know how to use the app. Record one with a trace,
then import it: its clicks, typing and expect() checks become a plan that AppStory
replays on camera. The test's own login is left out (AppStory logs in with "login:"),
and passwords are never copied. The test needs at least one expect().

Examples:
  npx playwright test tests/export.spec.ts --trace on
  npx app-story import acme test-results/export-bulk-export/trace.zip
  npx app-story test acme bulk-export        check it works
  npx app-story replay acme bulk-export      make its video`,
    )
    .action(async (productId: string, trace: string, opts: { name?: string; title?: string; force?: boolean }) => {
      const product = await openProduct(productId);
      const imported = await importTrace({ product, trace, ...opts });
      console.log(green(`✔ Saved ${bold(imported.name)} (${imported.workflow.steps.length} steps) to ${imported.file}`));
      for (const note of imported.notes) console.log(yellow(`  ! ${note}`));
      console.log(dim(`  Check it:      npx app-story test ${product.id} ${imported.name}`));
      console.log(dim(`  Make a video:  npx app-story replay ${product.id} ${imported.name}`));
    });
}
