import { Command, Option } from "commander";
import { TEMPLATE_NAMES, type TemplateName } from "@app-story/contracts";
import { redoVideo } from "@app-story/core";
import { globals, openProduct, shared, withLookOptions, type LookOptions } from "../context";
import { dim, exitCodeFor, printJob } from "../output";

export function redoCommand(): Command {
  return withLookOptions(new Command("redo"))
    .description("Make a video again from its kept recording, with the product file's current look (no app, no AI)")
    .argument("<product>", "product name")
    .argument("[video]", "the video's id from `history` (default: the newest)")
    .addOption(new Option("--template <name>", "use this look").choices(TEMPLATE_NAMES))
    .addHelpText(
      "after",
      `
The clicks, voice and timing stay as recorded. The look, logo, color, music and captions
come from the product file as it is now. The 5 newest videos of each product keep their recording.

Examples:
  npx app-story redo acme                          the newest acme video, with the current settings
  npx app-story redo acme --template tutorial      the same video in another look
  npx app-story redo acme --intro --captions       the same video with an intro and captions on it
  npx app-story redo acme 20261116-134205-a1b2c3   an older video`,
    )
    .action(async (productId: string, jobId: string | undefined, opts: { template?: TemplateName } & LookOptions, cmd: Command) => {
      const { outputDir, logLevel } = globals(cmd);
      opts = shared(opts, cmd);
      const product = await openProduct(productId, opts);
      const metadata = await redoVideo({
        product,
        outputDir,
        jobId,
        template: opts.template,
        logLevel,
        onJobCreated: (j) => console.log(dim(`Making it again → ${j.paths.root}`)),
      });
      printJob(metadata);
      process.exitCode = exitCodeFor(metadata);
    });
}
