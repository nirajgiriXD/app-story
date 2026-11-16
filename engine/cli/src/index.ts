import { config as loadEnv } from "dotenv";
import { ROOT_ENV_FILE } from "@showrun/shared";
import { buildProgram } from "./program";
import { printError } from "./output";

loadEnv({ path: ROOT_ENV_FILE, quiet: true });

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  printError(error);
  process.exitCode = 1;
}
