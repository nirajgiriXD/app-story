import type { Command } from "commander";
import { loadProduct, type LoadedProduct } from "@app-story/products";
import { workspace } from "@app-story/shared";

export interface GlobalOptions {
  logLevel?: string;
}

/** Products live in <workspace>/products and videos in <workspace>/output (see `workspace()`). */
export function globals(cmd: Command): { appsDir: string; outputDir: string; logLevel?: string } {
  const opts = cmd.optsWithGlobals<GlobalOptions>();
  const { appsDir, outputDir } = workspace();
  return { appsDir, outputDir, logLevel: opts.logLevel };
}

/** How the video is put together, from the command line: `--captions` and `--intro`. */
export interface LookOptions {
  captions?: boolean;
  intro?: boolean;
}

/**
 * A subcommand's options, with the ones the main command took. The main command has
 * `--intro`, `--captions` and `--headed` too, and commander gives a flag both define to it
 * (`redo acme --intro` sets the main command's), so subcommands read them through this.
 */
export function shared<T extends object>(opts: T, cmd: Command): T {
  return { ...opts, ...(cmd.optsWithGlobals() as Partial<T>) };
}

/** Add `--captions` and `--intro` to a command that makes a video. */
export function withLookOptions(cmd: Command): Command {
  return cmd
    .option("--captions", "draw the captions on the video (the .srt file is always made)")
    .option("--intro", "open with a full-screen intro instead of going straight to the app");
}

export async function openProduct(id: string, look: LookOptions = {}): Promise<LoadedProduct> {
  const product = await loadProduct(workspace().appsDir, id);
  if (!look.captions && !look.intro) return product;
  const config = structuredClone(product.config);
  if (look.captions) config.captions.burn_in = true;
  if (look.intro) config.demo.intro = true;
  return { ...product, config };
}

/** Names of commands, which therefore cannot be product names. */
export const RESERVED_NAMES = new Set(["new", "check", "list", "history", "redo", "resume", "replay", "test", "import", "help"]);
