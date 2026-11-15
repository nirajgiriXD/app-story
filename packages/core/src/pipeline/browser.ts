import { launchBrowserSession, type BrowserSession } from "@demoforge/browser";
import type { AdapterContext, LoadedProduct } from "@demoforge/products";
import type { Logger } from "@demoforge/shared";

export interface WithBrowserOptions {
  phase: AdapterContext["phase"];
  workDir: string;
  log: Logger;
  record?: boolean;
  headless?: boolean;
  mode?: "normal" | "read_only";
  traceFile?: string;
}

/**
 * Open an isolated browser session for one phase, running the product adapter's
 * setup/cleanup hooks around it. The browser is always closed, even on failure.
 */
export async function withBrowser<T>(
  product: LoadedProduct,
  options: WithBrowserOptions,
  fn: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  const { adapter, config } = product;
  const ctx: AdapterContext = { config, baseUrl: config.product.base_url, log: options.log, phase: options.phase };
  await adapter.setup?.(ctx);
  let session: BrowserSession | undefined;
  try {
    session = await launchBrowserSession({
      config,
      productDir: product.dir,
      workDir: options.workDir,
      log: options.log,
      record: options.record,
      headless: options.headless,
      mode: options.mode,
      traceFile: options.traceFile,
      initBrowser: adapter.initBrowser ? (page, context) => adapter.initBrowser!({ ...ctx, page, context }) : undefined,
      customVerify: adapter.verify
        ? async (name, page, context) => {
            const verify = adapter.verify?.[name];
            return verify ? verify({ ...ctx, page, context }) : false;
          }
        : undefined,
    });
    return await fn(session);
  } finally {
    await session?.close();
    await Promise.resolve(adapter.cleanup?.(ctx)).catch((error: Error) =>
      options.log.warn({ error: error.message }, "product cleanup hook failed"),
    );
  }
}
