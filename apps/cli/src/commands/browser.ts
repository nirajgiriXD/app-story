import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { Command } from "commander";
import { withBrowser } from "@demoforge/core";
import { resolveProductPath } from "@demoforge/products";
import { createLogger } from "@demoforge/shared";
import { globals, openProduct } from "../context";
import { dim, green } from "../output";

export function browserCommand(): Command {
  const browser = new Command("browser").description("Browser utilities");

  browser
    .command("inspect")
    .description("Open the product in a visible browser (with its auth and safety settings)")
    .requiredOption("--product <id>", "product id")
    .option("--save-auth [path]", "log in by hand, then save the session for `authentication.strategy: storage_state`")
    .action(async (opts: { product: string; saveAuth?: string | boolean }, cmd: Command) => {
      const { outputDir, logLevel } = globals(cmd);
      const product = await openProduct(cmd, opts.product);
      const log = createLogger({ level: logLevel });
      if (opts.saveAuth) {
        // Logging in by hand: start without any saved state.
        product.config.authentication = { strategy: "none" };
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await withBrowser(
        product,
        { phase: "dry_run", workDir: join(outputDir, product.id, ".inspect"), log, headless: false },
        async (session) => {
          console.log(green(`✔ Opened ${session.page.url()}`));
          if (opts.saveAuth) {
            await rl.question("Log in in the browser window, then press Enter here to save the session... ");
            const configured =
              typeof opts.saveAuth === "string" ? opts.saveAuth : join(".secrets", `${product.id}-state.json`);
            const path = resolveProductPath(product, configured);
            await session.saveStorageState(path);
            console.log(green(`✔ Saved login state to ${path}`));
            console.log(dim(`  Set in product.yaml:\n  authentication:\n    strategy: storage_state\n    storage_state_path: ${configured}`));
          } else {
            await rl.question("Press Enter to close the browser... ");
          }
        },
      );
      rl.close();
    });

  return browser;
}
