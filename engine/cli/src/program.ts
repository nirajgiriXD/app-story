import { Command } from "commander";
import { makeVideos, type MakeOptions } from "./commands/make";
import { checkCommand, listCommand, newCommand } from "./commands/manage";
import { historyCommand } from "./commands/history";

const EXAMPLES = `
Examples:
  npx showrun acme                          one video of what's new in products/acme.md
  npx showrun acme --each                   one video per new feature
  npx showrun acme "show how to export"     a video of anything else, in plain words
  npx showrun new acme                      create products/acme.md
  npx showrun check acme                    check settings, keys, login and tools`;

export function buildProgram(): Command {
  return new Command("showrun")
    .description("Make product demo videos from products/<product>.md")
    .version("0.1.0")
    .argument("[product]", "product name: the file products/<product>.md")
    .argument("[goal...]", "what to show, in plain words (default: what's new in the release notes)")
    .option("--each", "one video per new feature instead of one for all")
    .option("--fresh", "plan again instead of replaying a saved plan")
    .option("--headed", "show the browser window while working")
    .option("--log-level <level>", "debug, info, warn, error, silent")
    .showHelpAfterError()
    .addHelpText("after", EXAMPLES)
    .action((product: string | undefined, goal: string[], opts: MakeOptions, cmd: Command) => makeVideos(product, goal, opts, cmd))
    .addCommand(newCommand())
    .addCommand(checkCommand())
    .addCommand(listCommand())
    .addCommand(historyCommand());
}
