import { launchBrowserSession, type BrowserSession, type LoginState } from "@app-story/browser";
import type { LoadedProduct } from "@app-story/products";
import type { Logger } from "@app-story/shared";

export interface WithBrowserOptions {
  workDir: string;
  log: Logger;
  record?: boolean;
  headless?: boolean;
  mode?: "normal" | "read_only";
  traceFile?: string;
  loginState?: LoginState;
}

/** Open an isolated, logged-in browser session for one phase. It is always closed, even on failure. */
export async function withBrowser<T>(product: LoadedProduct, options: WithBrowserOptions, fn: (session: BrowserSession) => Promise<T>): Promise<T> {
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
      loginState: options.loginState,
    });
    return await fn(session);
  } finally {
    await session?.close();
  }
}
