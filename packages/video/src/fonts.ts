import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/*
 * The video's fonts. Inter (SIL Open Font License) ships with AppStory and is loaded by
 * the render page itself, so a video looks the same on every machine instead of falling
 * back to whatever sans-serif the system has. A brand font file from the product file is
 * loaded the same way.
 */

/** The family name a brand font file is loaded under. */
export const BRAND_FONT_FAMILY = "AppStory Brand";

/** Where the render page fetches the shipped Inter files. */
export const INTER_PATH = "/fonts/inter/";

const require = createRequire(import.meta.url);

/** The folder with Inter's font files. */
export function interDir(): string {
  return join(dirname(require.resolve("@fontsource-variable/inter/package.json")), "files");
}

let css: Promise<string> | undefined;

/**
 * Inter's @font-face rules, one per script (Latin, Cyrillic, Greek…), loaded only when the
 * text needs them. They take the name "Inter", which the browser then prefers to any
 * installed Inter, and block (never swap) so no frame is drawn with a stand-in font.
 */
export function interCss(): Promise<string> {
  css ??= readFile(join(interDir(), "..", "index.css"), "utf8").then((text) =>
    text.replaceAll("'Inter Variable'", "'Inter'").replaceAll("font-display: swap", "font-display: block").replaceAll("url(./files/", `url(${INTER_PATH}`),
  );
  return css;
}

/** The @font-face rule of a brand font file served at `url`. */
export function brandFontCss(url: string): string {
  return `@font-face{font-family:'${BRAND_FONT_FAMILY}';src:url(${JSON.stringify(url)});font-weight:100 900;font-display:block}`;
}
