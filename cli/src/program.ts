import { Command } from "commander";
import { makeVideos, type MakeOptions } from "./commands/make";
import { checkCommand, listCommand, newCommand } from "./commands/manage";
import { historyCommand } from "./commands/history";
import { redoCommand } from "./commands/redo";
import { resumeCommand } from "./commands/resume";
import { replayCommand } from "./commands/replay";
import { testCommand } from "./commands/test";
import { importCommand } from "./commands/import";

const EXAMPLES = `
Examples:
  npx app-story acme                          one video of what's new in apps/acme.md
  npx app-story acme --each                   one video per new feature
  npx app-story acme "show how to export"     a video of anything else, in plain words
  npx app-story acme --intro --captions       with a full-screen intro, and captions drawn on the video
  npx app-story acme --videos                 one video per goal listed under "## Videos"
  npx app-story redo acme --template tutorial the newest video again, in another look
  npx app-story acme --videos --review        see each new plan's steps and approve it before recording
  npx app-story resume acme                   finish the newest failed video, without planning again
  npx app-story replay acme                   every saved plan's video again, with no AI (for CI)
  npx app-story test acme                     check the saved plans still work in the app
  npx app-story import acme trace.zip         a Playwright test's trace as a saved plan
  npx app-story new acme                      create apps/acme.md
  npx app-story check acme                    check settings, keys, login and tools`;

export function buildProgram(): Command {
  return new Command("app-story")
    .description("Make product demo videos from apps/<product>.md")
    .version("0.1.0")
    .argument("[product]", "product name: the file apps/<product>.md")
    .argument("[goal...]", "what to show, in plain words (default: what's new in the release notes)")
    .option("--each", "one video per new feature instead of one for all")
    .option("--videos", 'one video per goal listed under "## Videos" in the product file')
    .option("--review", "show each newly planned video's steps and ask before recording it")
    .option("--captions", "draw the captions on the video (the .srt file is always made)")
    .option("--intro", "open with a full-screen intro instead of going straight to the app")
    .option("--fresh", "plan again instead of replaying a saved plan")
    .option("--headed", "show the browser window while working")
    .option("--log-level <level>", "debug, info, warn, error, silent")
    .showHelpAfterError()
    .addHelpText("after", EXAMPLES)
    .action((product: string | undefined, goal: string[], opts: MakeOptions, cmd: Command) => makeVideos(product, goal, opts, cmd))
    .addCommand(newCommand())
    .addCommand(checkCommand())
    .addCommand(listCommand())
    .addCommand(historyCommand())
    .addCommand(redoCommand())
    .addCommand(resumeCommand())
    .addCommand(replayCommand())
    .addCommand(testCommand())
    .addCommand(importCommand());
}
