import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Prompt versions in use. Bump the file suffix (and this table) when a prompt changes meaningfully. */
export const PROMPT_VERSIONS = {
  rehearsal: "v3",
  narration: "v2",
  "release-notes": "v2",
} as const;

export type PromptName = keyof typeof PROMPT_VERSIONS;

const cache = new Map<string, string>();

export function loadPrompt(name: PromptName): string {
  const file = `${name}.${PROMPT_VERSIONS[name]}.md`;
  let text = cache.get(file);
  if (!text) {
    text = readFileSync(join(here, file), "utf8").trim();
    cache.set(file, text);
  }
  return text;
}

/** Wrap untrusted website text so prompts can tell it apart from instructions. */
export function untrusted(content: string): string {
  const safe = content.replace(/<\/?page_content>/gi, "");
  return `<page_content>\n${safe}\n</page_content>`;
}
