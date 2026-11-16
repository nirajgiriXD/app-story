import type { Locator, Page } from "playwright";
import type { Target } from "@app-story/contracts";
import { AppStoryError } from "@app-story/shared";

type AriaRole = Parameters<Page["getByRole"]>[0];

const ARIA_ROLES = new Set<string>([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "meter",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);

export function describeTarget(t: Target): string {
  if (t.test_id) return `[data-testid=${t.test_id}]`;
  if (t.role) return `${t.role}${t.name ? ` "${t.name}"` : ""}${t.text ? ` with text "${t.text}"` : ""}`;
  if (t.label) return `field labelled "${t.label}"`;
  if (t.placeholder) return `field with placeholder "${t.placeholder}"`;
  if (t.text) return `text "${t.text}"`;
  return `css ${t.css}`;
}

/** Candidate locators, best first. Later candidates are fallbacks for small UI differences. */
export function buildLocators(page: Page, t: Target): Locator[] {
  const exact = t.exact ?? false;
  const out: Locator[] = [];
  if (t.test_id) out.push(page.getByTestId(t.test_id));
  if (t.role && ARIA_ROLES.has(t.role)) {
    let loc = page.getByRole(t.role as AriaRole, t.name ? { name: t.name, exact } : {});
    if (t.text) loc = loc.filter({ hasText: t.text });
    out.push(loc);
  }
  if (t.label) out.push(page.getByLabel(t.label, { exact }));
  if (t.placeholder) out.push(page.getByPlaceholder(t.placeholder, { exact }));
  if (t.text) out.push(page.getByText(t.text, { exact }));
  if (t.css) out.push(page.locator(t.css));
  // Fallbacks: a role+name target whose role differs slightly (link vs button) is still found by its name.
  if (t.name && !t.label) out.push(page.getByLabel(t.name, { exact }), page.getByText(t.name, { exact }));
  return out.map((loc) => (t.nth !== undefined ? loc.nth(t.nth) : loc));
}

async function firstVisible(loc: Locator, limit = 12): Promise<Locator | undefined> {
  const count = await loc.count();
  for (let i = 0; i < Math.min(count, limit); i++) {
    const candidate = loc.nth(i);
    if (await candidate.isVisible()) return candidate;
  }
  return undefined;
}

/**
 * Resolve a target to exactly one visible element, trying fallback strategies
 * until the timeout runs out.
 */
export async function resolveLocator(page: Page, target: Target, timeoutMs: number): Promise<Locator> {
  const candidates = buildLocators(page, target);
  if (candidates.length === 0) {
    throw new AppStoryError("WORKFLOW_FAILED", `Target has no usable selector: ${JSON.stringify(target)}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const found = await firstVisible(candidate).catch(() => undefined);
      if (found) return found;
    }
    await page.waitForTimeout(150);
  }
  throw new AppStoryError("WORKFLOW_FAILED", `Could not find ${describeTarget(target)} on the page.`, {
    details: { target, url: page.url() },
  });
}
