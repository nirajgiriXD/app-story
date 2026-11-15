import { Command } from "commander";
import { readHistory } from "@demoforge/core";
import { globals } from "../context";
import { dim, green, red, yellow } from "../output";

export function historyCommand(): Command {
  return new Command("history")
    .description("Show recent generation jobs")
    .option("--product <id>", "only this product")
    .option("--limit <n>", "number of jobs", "20")
    .option("--json", "print JSON")
    .action(async (opts: { product?: string; limit: string; json?: boolean }, cmd: Command) => {
      const { outputDir } = globals(cmd);
      const entries = await readHistory(outputDir, { productId: opts.product, limit: Number(opts.limit) });
      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log(dim("No jobs yet."));
        return;
      }
      for (const e of entries) {
        const icon = e.status === "success" ? green("✔") : e.status === "success_with_warnings" ? yellow("✔") : red("✖");
        const what = e.scenario_id ? `scenario ${e.scenario_id}` : e.objective ? `"${e.objective}"` : e.mode;
        const cost = e.cost_usd ? ` · $${e.cost_usd.toFixed(3)}` : "";
        console.log(`${icon} ${new Date(e.created_at).toLocaleString()}  ${e.product_id}  ${what}`);
        console.log(dim(`    ${e.status} · ${e.mode}${e.ai ? ` · ${e.ai}` : ""}${cost}`));
        console.log(dim(`    ${e.video ?? e.output_dir}`));
      }
    });
}
