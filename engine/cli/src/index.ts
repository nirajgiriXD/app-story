import { config as loadEnv } from "dotenv";
import { workspace } from "@app-story/shared";
import { buildProgram } from "./program";
import { printError } from "./output";

loadEnv({ path: workspace().envFile, quiet: true });

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  printError(error);
  process.exitCode = 1;
}
