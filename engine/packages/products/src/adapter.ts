import type { BrowserContext, Page } from "playwright";
import type { Logger } from "@demoforge/shared";
import type { ProductConfig } from "@demoforge/contracts";

export interface AdapterContext {
  config: ProductConfig;
  baseUrl: string;
  log: Logger;
  /** `rehearsal` (AI practice run), `recording` (final take), `dry_run` or `discovery`. */
  phase: "rehearsal" | "recording" | "dry_run" | "discovery";
}

export interface AdapterBrowserContext extends AdapterContext {
  page: Page;
  context: BrowserContext;
}

/**
 * Optional, product-specific extension points. The core engine never needs one:
 * when a product has no `adapter.ts`/`adapter.mjs`, the generic (empty) adapter is used.
 */
export interface ProductAdapter {
  /** Runs before the browser opens, e.g. to reset demo data through an API. */
  setup?(ctx: AdapterContext): Promise<void>;
  /** Runs after the browser closes, even on failure. */
  cleanup?(ctx: AdapterContext): Promise<void>;
  /** Runs after the browser context is created and authenticated, before the workflow. */
  initBrowser?(ctx: AdapterBrowserContext): Promise<void>;
  /** Custom verification functions, referenced from workflows as `expected: { type: custom, name }`. */
  verify?: Record<string, (ctx: AdapterBrowserContext) => Promise<boolean>>;
}

export const genericAdapter: ProductAdapter = {};

export function defineAdapter(adapter: ProductAdapter): ProductAdapter {
  return adapter;
}
