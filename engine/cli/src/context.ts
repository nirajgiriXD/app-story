import type { Command } from "commander";
import { loadProduct, type LoadedProduct } from "@app-story/products";
import { workspace } from "@app-story/shared";

export interface GlobalOptions {
  logLevel?: string;
}

/** Products live in <workspace>/products and videos in <workspace>/output (see `workspace()`). */
export function globals(cmd: Command): { productsDir: string; outputDir: string; logLevel?: string } {
  const opts = cmd.optsWithGlobals<GlobalOptions>();
  const { productsDir, outputDir } = workspace();
  return { productsDir, outputDir, logLevel: opts.logLevel };
}

export async function openProduct(id: string): Promise<LoadedProduct> {
  return loadProduct(workspace().productsDir, id);
}

/** Names of commands, which therefore cannot be product names. */
export const RESERVED_NAMES = new Set(["new", "check", "list", "history", "redo", "resume", "replay", "test", "import", "help"]);
