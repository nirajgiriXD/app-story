import { Command } from "commander";
import { validateProduct } from "@demoforge/core";
import { openProduct } from "../context";
import { green, red, yellow } from "../output";

export function validateCommand(): Command {
  return new Command("validate")
    .description("Validate a product's configuration, scenarios, credentials and local tools")
    .requiredOption("--product <id>", "product id")
    .action(async (opts: { product: string }, cmd: Command) => {
      const product = await openProduct(cmd, opts.product);
      const items = await validateProduct(product);
      for (const item of items) {
        const icon = item.level === "ok" ? green("✔") : item.level === "warning" ? yellow("!") : red("✖");
        console.log(`${icon} ${item.message}`);
      }
      const errors = items.filter((i) => i.level === "error").length;
      console.log(errors ? red(`\n${errors} problem(s) found.`) : green("\nReady to generate demos."));
      process.exitCode = errors ? 1 : 0;
    });
}
