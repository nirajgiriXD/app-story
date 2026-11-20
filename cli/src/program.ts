import { Command } from "commander";
import { makeVideos, type MakeOptions } from "./commands/make";
import { checkCommand, listCommand, newCommand } from "./commands/manage";
import { historyCommand } from "./commands/history";
import { redoCommand } from "./commands/redo";
import { resumeCommand } from "./commands/resume";
import { replayCommand } from "./commands/replay";
import { testCommand } from "./commands/test";
import { importCommand } from "./commands/import";
import { blogCommand } from "./commands/blog";
import { CAPTIONS_HELP, CHAPTERS_HELP, INTRO_HELP, KEYS_HELP } from "./context";
import { startProgress, stopProgress } from "./progress";

const EXAMPLES = `
Examples:
  app-story acme                          one video of what's new in apps/acme.md
  app-story acme --each                   one video per new feature
  app-story acme "show how to export"     a video of anything else, in plain words
  app-story acme --intro --captions       with a full-screen intro, and captions drawn on the video
  app-story acme --chapters --no-keys     with chapter labels, and without keycaps
  app-story acme --verbose                every log line, instead of one live line per task
  app-story acme --videos                 one video per goal listed under "## Videos"
  app-story acme --no-blog                without the blog post written with each video
  app-story redo acme --template tutorial the newest video again, in another look
  app-story blog acme                     the newest video's blog post again (steps, screenshots, video)
  app-story acme --videos --review        see each new plan's steps and approve it before recording
  app-story resume acme                   finish the newest failed video, without planning again
  app-story replay acme                   every saved plan's video again, with no AI (for CI)
  app-story test acme                     check the saved plans still work in the app
  app-story import acme trace.zip         a Playwright test's trace as a saved plan
  app-story new acme                      create apps/acme.md
  app-story check acme                    check settings, keys, login and tools`;

export function buildProgram(): Command {
  return (
    new Command("app-story")
      .description("Make product demo videos from apps/<product>.md")
      .version("0.1.0")
      .argument("[product]", "product name: the file apps/<product>.md")
      .argument("[goal...]", "what to show, in plain words (default: what's new in the release notes)")
      .option("--each", "one video per new feature instead of one for all")
      .option("--videos", 'one video per goal listed under "## Videos" in the product file')
      .option("--review", "show each newly planned video's steps and ask before recording it")
      .option("--captions", CAPTIONS_HELP)
      .option("--intro", INTRO_HELP)
      .option("--chapters", CHAPTERS_HELP)
      .option("--no-keys", KEYS_HELP)
      .option("--no-blog", "make the videos without a blog post")
      .option("--fresh", "plan again instead of replaying a saved plan")
      .option("--headed", "show the browser window while working")
      .option("--verbose", "print every log line instead of one live line per task")
      .option("--log-level <level>", "debug, info, warn, error, silent")
      .showHelpAfterError()
      // One live line per task while a command runs (see progress.ts); `--verbose` prints every log line.
      .hook("preAction", (_program, action) => startProgress({ verbose: Boolean(action.optsWithGlobals().verbose) }))
      .hook("postAction", () => stopProgress())
      .addHelpText("after", EXAMPLES)
      .action((product: string | undefined, goal: string[], opts: MakeOptions, cmd: Command) => makeVideos(product, goal, opts, cmd))
      .addCommand(newCommand())
      .addCommand(checkCommand())
      .addCommand(listCommand())
      .addCommand(historyCommand())
      .addCommand(redoCommand())
      .addCommand(blogCommand())
      .addCommand(resumeCommand())
      .addCommand(replayCommand())
      .addCommand(testCommand())
      .addCommand(importCommand())
  );
}
