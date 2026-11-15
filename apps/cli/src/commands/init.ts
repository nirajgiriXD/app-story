import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { scaffoldProduct } from "@demoforge/products";
import { slugify } from "@demoforge/shared";
import { globals } from "../context";
import { dim, green } from "../output";

interface InitOptions {
  id?: string;
  name?: string;
  url?: string;
  description?: string;
  aiProvider: "anthropic" | "openai";
  ttsProvider: "elevenlabs" | "openai";
}

export function initCommand(): Command {
  return new Command("init")
    .description("Create a new product configuration under products/<id>/")
    .option("--id <id>", "product id (lowercase, dashes)")
    .option("--name <name>", "product name")
    .option("--url <url>", "base URL of the application")
    .option("--description <text>", "one-line product description")
    .option("--ai-provider <provider>", "anthropic or openai", "anthropic")
    .option("--tts-provider <provider>", "elevenlabs or openai", "openai")
    .action(async (opts: InitOptions, cmd: Command) => {
      const { productsDir } = globals(cmd);
      const ask = await prompter();
      const name = opts.name ?? (await ask("Product name", "My App"));
      const id = opts.id ?? slugify(await ask("Product id", slugify(name)));
      const url = opts.url ?? (await ask("Base URL", "http://localhost:3000"));
      const description = opts.description ?? (await ask("One-line description", `${name} web application`));
      ask.close();
      const dir = await scaffoldProduct(productsDir, {
        id,
        name,
        baseUrl: url,
        description,
        aiProvider: opts.aiProvider,
        ttsProvider: opts.ttsProvider,
      });
      console.log(green(`✔ Created ${dir}`));
      console.log(dim(`  Next: edit product.yaml and knowledge/, then run \`demoforge validate --product ${id}\`.`));
    });
}

async function prompter(): Promise<((q: string, fallback: string) => Promise<string>) & { close(): void }> {
  if (!process.stdin.isTTY) {
    const f = async (_q: string, fallback: string) => fallback;
    return Object.assign(f, { close() {} });
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const f = async (q: string, fallback: string) => (await rl.question(`${q} ${dim(`(${fallback})`)}: `)).trim() || fallback;
  return Object.assign(f, { close: () => rl.close() });
}
