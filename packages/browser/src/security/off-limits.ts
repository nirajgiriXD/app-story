import type { ActionGuard, GuardDecision } from "./action-guard";

/** Roles a planner would click, check or pick: the ones the guard can refuse. */
const CLICKABLE = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "switch", "option", "treeitem"]);

export interface OffLimitsElement {
  role: string;
  name: string;
  /** Why the guard refuses it, e.g. "delete" or "read_only". */
  category: NonNullable<GuardDecision["category"]>;
}

/** One element line of an accessibility snapshot: `- button "Delete project" [disabled]:`. */
const LINE = /^\s*- ([a-z]+) "((?:[^"\\]|\\.)*)"/;

/**
 * The elements of a page snapshot that the action guard would refuse to click, so the
 * planner can be told before it tries them, instead of spending a turn on a refusal.
 * Best effort and advisory: the guard still checks every real action.
 */
export function offLimitsElements(snapshot: string, guard: ActionGuard, max = 20): OffLimitsElement[] {
  const found: OffLimitsElement[] = [];
  const seen = new Set<string>();
  for (const line of snapshot.split("\n")) {
    const match = LINE.exec(line);
    if (!match) continue;
    const role = match[1] as string;
    const name = (match[2] as string).replace(/\\(.)/g, "$1").trim();
    if (!CLICKABLE.has(role) || !name) continue;
    const decision = guard.check("click", { role, name, tag: "" });
    if (decision.allowed || !decision.category) continue;
    const key = `${role}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ role, name, category: decision.category });
    if (found.length >= max) break;
  }
  return found;
}
