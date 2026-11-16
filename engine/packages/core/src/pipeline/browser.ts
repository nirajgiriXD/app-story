import { launchBrowserSession, type BrowserSession } from "@demoforge/browser";
import type { LoadedProduct } from "@demoforge/products";
import type { Logger } from "@demoforge/shared";

export interface WithBrowserOptions {
  workDir: string;
  log: Logger;
  record?: boolean;
  headless?: boolean;
  mode?: "normal" | "read_only";
  traceFile?: string;
}

/** Open an isolated, logged-in browser session for one phase. It is always closed, even on failure. */
export async function withBrowser<T>(
  product: LoadedProduct,
  options: WithBrowserOptions,
  fn: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  let session: BrowserSession | undefined;
  try {
    session = await launchBrowserSession({
      config: product.config,
      workDir: options.workDir,
      log: options.log,
      record: options.record,
      headless: options.headless,
      mode: options.mode,
      traceFile: options.traceFile,
    });
    return await fn(session);
  } finally {
    await session?.close();
  }
}
