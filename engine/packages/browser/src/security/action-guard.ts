import type { SafetyConfig, StepAction } from "@app-story/contracts";

export type SensitiveCategory = "delete" | "payments" | "emails" | "publishing" | "account_settings" | "invite_users";

/** Conservative keyword lists. A false positive blocks a click; a false negative could do real harm. */
export const SENSITIVE_KEYWORDS: Record<SensitiveCategory, readonly string[]> = {
  delete: ["delete", "remove", "destroy", "erase", "purge", "trash", "terminate", "deactivate", "wipe", "drop"],
  payments: [
    "pay", "pay now", "purchase", "buy", "checkout", "check out", "place order", "subscribe", "upgrade",
    "charge", "add card", "payment", "billing", "cancel subscription", "refund",
  ],
  emails: ["send", "email", "e-mail", "resend", "notify", "mail"],
  publishing: ["publish", "go live", "deploy", "release", "make public", "unpublish", "post"],
  account_settings: [
    "change password", "reset password", "delete account", "close account", "two-factor", "2fa",
    "transfer ownership", "change email", "api key", "revoke", "sign out everywhere",
  ],
  invite_users: ["invite", "add member", "add user", "add teammate", "share access", "add collaborator"],
};

const READ_ONLY_CLICK_ROLES = new Set(["link", "tab", "menuitem", "treeitem", "option", "switch-view"]);

export interface ElementInfo {
  role: string;
  name: string;
  tag: string;
  type?: string;
}

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
  category?: SensitiveCategory | "blocked_keyword" | "read_only";
}

function matchesKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(text);
}

export function classifySensitive(text: string): SensitiveCategory | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  for (const [category, keywords] of Object.entries(SENSITIVE_KEYWORDS) as [SensitiveCategory, readonly string[]][]) {
    if (keywords.some((k) => matchesKeyword(normalized, k))) return category;
  }
  return null;
}

const INTERACTIVE_ACTIONS: readonly StepAction[] = ["click", "check", "uncheck", "select", "press"];
const MUTATING_ACTIONS: readonly StepAction[] = ["fill", "select", "check", "uncheck", "press"];

/**
 * Decides whether an action on an element is allowed. Enforced in code, below the AI:
 * nothing a web page or a model says can switch these checks off.
 */
export class ActionGuard {
  readonly readOnly: boolean;

  constructor(
    private readonly safety: SafetyConfig,
    mode: "normal" | "read_only" = "normal",
  ) {
    this.readOnly =
      mode === "read_only" || (safety.environment === "production" && !safety.allow.production_data);
  }

  check(action: StepAction, element: ElementInfo | undefined, extraText = ""): GuardDecision {
    const text = `${element?.name ?? ""} ${extraText}`.trim();

    const blocked = this.safety.blocked_keywords.find((k) => k && matchesKeyword(text.toLowerCase(), k.toLowerCase()));
    if (blocked && action !== "hover" && action !== "scroll") {
      return { allowed: false, category: "blocked_keyword", reason: `"${text}" matches blocked keyword "${blocked}".` };
    }

    if (this.readOnly) {
      if (MUTATING_ACTIONS.includes(action) && !(action === "press" && isNavigationKey(extraText))) {
        return { allowed: false, category: "read_only", reason: `${action} is not allowed in read-only mode.` };
      }
      if (action === "click" && element) {
        const isSubmit = element.type === "submit" || (element.tag === "button" && element.type === undefined);
        const safeRole = READ_ONLY_CLICK_ROLES.has(element.role);
        const safeButton = element.role === "button" && !isSubmit && classifySensitive(element.name) === null;
        if (!safeRole && !safeButton) {
          return {
            allowed: false,
            category: "read_only",
            reason: `Clicking ${element.role} "${element.name}" could change data; only navigation clicks are allowed in read-only mode.`,
          };
        }
      }
    }

    if (INTERACTIVE_ACTIONS.includes(action)) {
      const category = classifySensitive(text);
      if (category && !this.isAllowed(category)) {
        return {
          allowed: false,
          category,
          reason: `"${text}" looks like a ${category.replace("_", " ")} action, which this product does not allow (safety.allow.${category}).`,
        };
      }
    }
    return { allowed: true };
  }

  private isAllowed(category: SensitiveCategory): boolean {
    return this.safety.allow[category];
  }
}

function isNavigationKey(key: string): boolean {
  return /^(Tab|Shift\+Tab|Escape|Arrow(Up|Down|Left|Right)|PageUp|PageDown|Home|End)$/i.test(key.trim());
}
