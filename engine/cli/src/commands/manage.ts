import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { validateProduct } from "@demoforge/core";
import { listProducts, newProductFile } from "@demoforge/products";
import { DemoForgeError, slugify } from "@demoforge/shared";
import { RESERVED_NAMES, globals, openProduct } from "../context";
import { bold, dim, green, red, yellow } from "../output";

export function newCommand(): Command {
  return new Command("new")
    .description("Create products/<name>.md for a new product")
    .argument("<name>", "short product name, e.g. acme (lowercase, dashes)")
    .option("--url <url>", "address of the running app")
    .action(async (rawName: string, opts: { url?: string }, cmd: Command) => {
      const id = slugify(rawName);
      if (RESERVED_NAMES.has(id)) throw new DemoForgeError("CONFIG_INVALID", `'${id}' is a command name; pick another product name.`);
      const url = opts.url ?? (await ask("Address of the app", "https://staging.my-app.com"));
      const file = await newProductFile(globals(cmd).productsDir, { id, url });
      console.log(green(`✔ Created ${file}`));
      console.log(dim("  Add the login if the app has one, describe the app and paste your release notes."));
      console.log(dim(`  Then: npx demoforge check ${id}   and   npx demoforge ${id}`));
    });
}

export function checkCommand(): Command {
  return new Command("check")
    .description("Check a product file, keys, login, the app and local tools")
    .argument("<product>", "product name")
    .action(async (id: string, _opts, cmd: Command) => {
      const product = await openProduct(id);
      const items = await validateProduct(product, { outputDir: globals(cmd).outputDir });
      for (const item of items) {
        const icon = item.level === "ok" ? green("✔") : item.level === "warning" ? yellow("!") : red("✖");
        console.log(`${icon} ${item.message}`);
      }
      const errors = items.filter((i) => i.level === "error").length;
      console.log(errors ? red(`\n${errors} problem(s) found.`) : green(`\nReady: npx demoforge ${id}`));
      process.exitCode = errors ? 1 : 0;
    });
}

export function listCommand(): Command {
  return new Command("list").description("List your products").action(async (_opts, cmd: Command) => {
    const { productsDir } = globals(cmd);
    const items = await listProducts(productsDir);
    if (items.length === 0) {
      console.log(dim(`No products yet. Create one with: npx demoforge new <name>`));
      return;
    }
    for (const p of items) {
      if (p.valid) console.log(`${green("●")} ${bold(p.id)}  ${p.name}  ${dim(p.base_url ?? "")}`);
      else console.log(`${red("●")} ${bold(p.id)}  ${red("invalid")} ${dim(p.error?.split("\n")[0] ?? "")}`);
    }
  });
}

async function ask(question: string, example: string): Promise<string> {
  if (!process.stdin.isTTY) return example;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} ${dim(`(e.g. ${example})`)}: `)).trim();
  rl.close();
  return answer || example;
}
