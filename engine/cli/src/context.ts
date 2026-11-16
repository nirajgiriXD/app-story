import type { Command } from "commander";
import { loadProduct, type LoadedProduct } from "@app-story/products";
import { OUTPUT_DIR, PRODUCTS_DIR } from "@app-story/shared";

export interface GlobalOptions {
  logLevel?: string;
}

/** Products always live in <repo>/products and jobs in <repo>/output. */
export function globals(cmd: Command): { productsDir: string; outputDir: string; logLevel?: string } {
  const opts = cmd.optsWithGlobals<GlobalOptions>();
  return { productsDir: PRODUCTS_DIR, outputDir: OUTPUT_DIR, logLevel: opts.logLevel };
}

export async function openProduct(id: string): Promise<LoadedProduct> {
  return loadProduct(PRODUCTS_DIR, id);
}

/** Names of commands, which therefore cannot be product names. */
export const RESERVED_NAMES = new Set(["new", "check", "list", "history", "help"]);
