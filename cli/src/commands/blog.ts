import { relative } from "node:path";
import { Command } from "commander";
import { writeBlog } from "@app-story/core";
import { globals, openProduct } from "../context";
import { bold, dim, green } from "../output";

export function blogCommand(): Command {
  return new Command("blog")
    .description("Write the blog post of a video from its kept recording: steps, voice-over and screenshots (no app, one AI request)")
    .argument("<product>", "product name")
    .argument("[video]", "the video's id from `history` (default: the newest)")
    .addHelpText(
      "after",
      `
Every new video comes with a blog post already (<video>.blog.md and its screenshots, next to it;
APP_STORY_BLOG=off or --no-blog leaves it out). Use this to write it again, after editing the
product file, or for a video made without one (a replay, a redo). The new post replaces the old one.
The 5 newest videos of each product keep their recording.

Examples:
  app-story blog acme                          the newest acme video
  app-story blog acme 20261116-134205-a1b2c3   an older one`,
    )
    .action(async (productId: string, jobId: string | undefined, _opts: unknown, cmd: Command) => {
      const { outputDir, logLevel } = globals(cmd);
      const product = await openProduct(productId);
      const result = await writeBlog({ product, outputDir, jobId, logLevel });
      const cost = result.costUsd ? ` · $${result.costUsd.toFixed(3)}` : "";
      console.log(`${green("✔")} ${bold("Blog post")} ${relative(process.cwd(), result.file)} ${dim(`(${result.provider}${cost})`)}`);
      const shown = [
        `${result.images.length} screenshot${result.images.length === 1 ? "" : "s"}`,
        result.video ? "the video embedded" : "no video (it is no longer in output/)",
      ];
      console.log(dim(`  ${shown.join(", ")}`));
    });
}
