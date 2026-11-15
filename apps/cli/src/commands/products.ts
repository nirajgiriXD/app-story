import { Command } from "commander";
import { listProducts, loadScenario } from "@demoforge/products";
import { globals, openProduct } from "../context";
import { bold, dim, green, red, yellow } from "../output";

export function productsCommand(): Command {
  const products = new Command("products").description("List and inspect configured products");

  products
    .command("list")
    .description("List configured products")
    .action(async (_opts, cmd: Command) => {
      const { productsDir } = globals(cmd);
      const items = await listProducts(productsDir);
      if (items.length === 0) {
        console.log(dim(`No products in ${productsDir}. Create one with \`demoforge init\`.`));
        return;
      }
      for (const p of items) {
        if (p.valid) console.log(`${green("●")} ${bold(p.id)}  ${p.name}  ${dim(`${p.base_url} · ${p.ai_provider}`)}`);
        else console.log(`${red("●")} ${bold(p.id)}  ${red("invalid")} ${dim(p.error?.split("\n")[0] ?? "")}`);
      }
    });

  products
    .command("inspect <id>")
    .description("Show a product's configuration, knowledge and scenarios")
    .action(async (id: string, _opts, cmd: Command) => {
      const product = await openProduct(cmd, id);
      const c = product.config;
      console.log(bold(`${c.product.name}`) + dim(` (${product.id})`));
      console.log(`  ${c.product.description}`);
      console.log(`  URL:          ${c.product.base_url}`);
      console.log(`  Domains:      ${c.browser.allowed_domains.join(", ")}`);
      console.log(`  Auth:         ${c.authentication.strategy}`);
      console.log(`  AI:           ${c.providers.ai.provider}${c.providers.ai.model ? ` / ${c.providers.ai.model}` : " (default model)"}${c.providers.ai_fallback ? ` → fallback ${c.providers.ai_fallback.provider}` : ""}`);
      console.log(`  Voice:        ${c.providers.tts.provider}${c.providers.tts.voice ? ` / ${c.providers.tts.voice}` : ""}`);
      console.log(`  Video:        ${c.demo.default_resolution} @ ${c.demo.fps}fps, template ${c.demo.template}, ~${c.demo.default_duration}s`);
      console.log(`  Safety:       ${c.safety.environment}; allowed: ${Object.entries(c.safety.allow).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`);
      console.log(`  Knowledge:    ${product.knowledge.map((k) => k.file).join(", ") || "(none)"}`);
      console.log(`  Adapter:      ${product.adapterPath ?? "generic"}`);
      console.log(`  Scenarios:`);
      if (product.scenarios.length === 0) console.log(dim("    (none)"));
      for (const s of product.scenarios) {
        try {
          const w = await loadScenario(product, s);
          console.log(`    ${w.approved ? green("✔") : yellow("○")} ${s}  ${dim(`${w.title} · ${w.steps.length} steps${w.approved ? "" : " · not approved"}`)}`);
        } catch (e) {
          console.log(`    ${red("✖")} ${s}  ${dim((e as Error).message.split("\n")[0] ?? "")}`);
        }
      }
    });

  return products;
}
