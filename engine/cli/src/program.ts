import { Command } from "commander";
import { initCommand } from "./commands/init";
import { productsCommand } from "./commands/products";
import { validateCommand } from "./commands/validate";
import { generateCommand } from "./commands/generate";
import { runCommand } from "./commands/run";
import { discoverCommand } from "./commands/discover";
import { browserCommand } from "./commands/browser";
import { historyCommand } from "./commands/history";

export function buildProgram(): Command {
  return new Command("demoforge")
    .description("Generate product demo videos from real web applications")
    .version("0.1.0")
    .option("--log-level <level>", "trace, debug, info, warn, error")
    .showHelpAfterError()
    .addCommand(initCommand())
    .addCommand(productsCommand())
    .addCommand(validateCommand())
    .addCommand(discoverCommand())
    .addCommand(generateCommand())
    .addCommand(runCommand())
    .addCommand(browserCommand())
    .addCommand(historyCommand());
}
