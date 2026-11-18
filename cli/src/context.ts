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

/** How the video is put together, from the command line: `--captions`, `--intro`, `--chapters` and `--no-keys`. */
export interface LookOptions {
  captions?: boolean;
  intro?: boolean;
  chapters?: boolean;
  /** False with `--no-keys`. */
  keys?: boolean;
}

/**
 * A subcommand's options, with the ones the main command took. The main command has
 * `--intro`, `--captions`, `--chapters`, `--no-keys` and `--headed` too, and commander gives a flag both define to it
 * (`redo acme --intro` sets the main command's), so subcommands read them through this.
 */
export function shared<T extends object>(opts: T, cmd: Command): T {
  return { ...opts, ...(cmd.optsWithGlobals() as Partial<T>) };
}

/** Add `--captions`, `--intro`, `--chapters` and `--no-keys` to a command that makes a video. */
export function withLookOptions(cmd: Command): Command {
  return cmd.option("--captions", CAPTIONS_HELP).option("--intro", INTRO_HELP).option("--chapters", CHAPTERS_HELP).option("--no-keys", KEYS_HELP);
}

export const CAPTIONS_HELP = "draw the captions on the video (the .srt file is always made)";
export const INTRO_HELP = "open with a full-screen intro instead of going straight to the app";
export const KEYS_HELP = "hide the keycaps (Ctrl K) shown over the app when a key is pressed";
export const CHAPTERS_HELP = "show a label with each chapter's name over the app as it begins (the MP4 lists them either way)";

export async function openProduct(id: string, look: LookOptions = {}): Promise<LoadedProduct> {
  const product = await loadProduct(workspace().appsDir, id);
  if (!look.captions && !look.intro && !look.chapters && look.keys !== false) return product;
  const config = structuredClone(product.config);
  if (look.captions) config.captions.burn_in = true;
  if (look.intro) config.demo.intro = true;
  if (look.chapters) config.demo.chapters = true;
  if (look.keys === false) config.demo.keys = false;
  return { ...product, config };
}

/** Names of commands, which therefore cannot be product names. */
export const RESERVED_NAMES = new Set(["new", "check", "list", "history", "redo", "resume", "replay", "test", "import", "help"]);
