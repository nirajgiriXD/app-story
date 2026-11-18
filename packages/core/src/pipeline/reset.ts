import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { LoadedProduct } from "@app-story/products";
import { AppStoryError, redactSecrets, resolveEnvTemplate, type Logger } from "@app-story/shared";

/** The longest a reset may take (a database reseed can be slow). */
export const RESET_TIMEOUT_MS = 5 * 60_000;

/**
 * Put the app's demo data back as it was (`reset:` in the product file). The practice run
 * really creates things in the app (a project, an invoice); without a reset, the recording
 * creates them a second time, so lists show them twice, or the app refuses a name that is
 * taken. An http(s) address is sent a POST; anything else is a shell command, run in the
 * project folder. `{{env:NAME}}` reads a value (a token) from the environment, kept secret.
 */
export async function resetDemoData(product: LoadedProduct, log: Logger, before: string): Promise<void> {
  const reset = product.config.product.reset;
  if (!reset) return;
  const resolved = resolveEnvTemplate(reset);
  log.info({ before }, "resetting the demo data");
  if (/^https?:\/\//i.test(resolved)) await resetByRequest(resolved);
  else await resetByCommand(resolved, dirname(product.dir));
}

async function resetByRequest(url: string): Promise<void> {
  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(RESET_TIMEOUT_MS) }).catch((error: Error) => {
    throw new AppStoryError("RESET_FAILED", redactSecrets(`The reset address could not be reached: ${error.message}`), {
      hint: "Check reset: in the product file, and that the app is running.",
      cause: error,
    });
  });
  if (!res.ok) {
    throw new AppStoryError("RESET_FAILED", redactSecrets(`The reset address answered HTTP ${res.status}.`), {
      hint: "reset: is sent a POST request; it must answer with a 2xx status once the demo data is back.",
    });
  }
}

function resetByCommand(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill(), RESET_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new AppStoryError("RESET_FAILED", redactSecrets(`The reset command could not start: ${error.message}`), { cause: error }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(
        new AppStoryError("RESET_FAILED", redactSecrets(`The reset command failed (exit code ${code ?? "killed"}): ${output.trim().slice(-500)}`), {
          hint: "reset: runs in the project folder and must exit with 0 once the demo data is back.",
        }),
      );
    });
  });
}
