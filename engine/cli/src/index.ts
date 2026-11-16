import { config as loadEnv } from "dotenv";
import { buildProgram } from "./program";
import { printError } from "./output";

loadEnv({ quiet: true });

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  printError(error);
  process.exitCode = 1;
}
