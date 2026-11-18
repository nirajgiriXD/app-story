import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { config as loadEnv } from "dotenv";
import { workspace } from "@app-story/shared";
import { buildProgram } from "./program";
import { printError } from "./output";

// Node tries a host's IPv6 and IPv4 addresses in turn, giving each only 250 ms. Where IPv6
// does not route and IPv4 takes longer than that to connect (e.g. huggingface.co, for the
// Kokoro voice model), every attempt is cut off and fetch fails; a second each is enough.
setDefaultAutoSelectFamilyAttemptTimeout(1000);

loadEnv({ path: workspace().envFile, quiet: true });

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  printError(error);
  process.exitCode = 1;
}
