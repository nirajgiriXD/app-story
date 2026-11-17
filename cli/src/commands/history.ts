import { Command } from "commander";
import { readHistory } from "@app-story/core";
import { globals } from "../context";
import { dim, green, red, yellow } from "../output";

export function historyCommand(): Command {
  return new Command("history")
    .description("Show recent videos")
    .argument("[product]", "only this product")
    .option("--limit <n>", "number of jobs", "20")
    .option("--json", "print JSON")
    .action(async (productId: string | undefined, opts: { limit: string; json?: boolean }, cmd: Command) => {
      const { outputDir } = globals(cmd);
      const entries = await readHistory(outputDir, { productId, limit: Number(opts.limit) });
      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log(dim("No videos yet."));
        return;
      }
      for (const e of entries) {
        const icon = e.status === "success" ? green("✔") : e.status === "success_with_warnings" ? yellow("✔") : red("✖");
        const firstLine = (e.objective ?? e.mode).split("\n")[0] ?? "";
        const what = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
        const how = e.mode === "scenario" ? "replayed saved plan" : e.mode === "redo" ? "made again from a kept recording" : "planned by AI";
        const cost = e.cost_usd ? ` · $${e.cost_usd.toFixed(3)}` : "";
        console.log(`${icon} ${new Date(e.created_at).toLocaleString()}  ${e.product_id}  ${what}  ${dim(e.job_id)}`);
        console.log(dim(`    ${e.status.replace(/_/g, " ")} · ${how}${e.ai ? ` · ${e.ai}` : ""}${cost}`));
        console.log(dim(`    ${e.video ?? e.output_dir}`));
      }
    });
}
