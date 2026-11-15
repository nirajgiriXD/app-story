import type { Locator, Page } from "playwright";
import type { Box, BrowserIssue, Condition, CursorPoint, Expectation, Target } from "@demoforge/contracts";
import { DemoForgeError, sleep, type Logger } from "@demoforge/shared";
import type { ActionOptions, ActionOutcome, BrowserController, PageObservation, VerificationResult } from "../types";
import { buildLocators, resolveLocator, describeTarget } from "../selectors/locator";
import { ActionGuard, type ElementInfo } from "../security/action-guard";
import { isAllowedUrl, resolveUrl } from "../security/url-guard";

export interface PlaywrightControllerOptions {
  baseUrl: string;
  allowedDomains: string[];
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  guard: ActionGuard;
  log: Logger;
  pacing: { cursorMoveMs: number; typingDelayMs: number };
  /** Shared list that page listeners append console/network problems to. */
  issues: BrowserIssue[];
  /** Product-adapter verification functions for `expected.type: custom`. */
  customVerify?: (name: string) => Promise<boolean>;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class PlaywrightController implements BrowserController {
  readonly issues: BrowserIssue[];
  readonly cursor: CursorPoint[] = [];
  private origin = Date.now();
  private presentation = false;
  private mouse = { x: 0, y: 0 };

  constructor(
    readonly page: Page,
    private readonly options: PlaywrightControllerOptions,
  ) {
    this.issues = options.issues;
    const viewport = page.viewportSize();
    if (viewport) this.mouse = { x: viewport.width / 2, y: viewport.height / 2 };
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  now(): number {
    return Date.now() - this.origin;
  }

  setClockOrigin(epochMs: number): void {
    this.origin = epochMs;
    this.cursor.length = 0;
    this.cursor.push({ t: this.now(), x: this.mouse.x, y: this.mouse.y });
  }

  setPresentationMode(enabled: boolean): void {
    this.presentation = enabled;
  }

  currentUrl(): string {
    return this.page.url();
  }

  private timeout(options?: ActionOptions): number {
    return options?.timeoutMs ?? this.options.actionTimeoutMs;
  }

  // ---------------------------------------------------------------- actions

  async navigate(urlOrPath: string, options?: ActionOptions): Promise<ActionOutcome> {
    const url = resolveUrl(this.options.baseUrl, urlOrPath);
    if (!isAllowedUrl(url, this.options.allowedDomains)) {
      throw new DemoForgeError("POLICY_VIOLATION", `Navigation to ${url} is outside the allowed domains.`, {
        hint: "Add the host to browser.allowed_domains in product.yaml if it is safe.",
      });
    }
    try {
      const response = await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options?.timeoutMs ?? this.options.navigationTimeoutMs,
      });
      if (response && response.status() >= 500) {
        throw new DemoForgeError("APP_UNAVAILABLE", `${url} answered with HTTP ${response.status()}.`);
      }
    } catch (error) {
      if (error instanceof DemoForgeError) throw error;
      const message = (error as Error).message;
      if (/ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_RESET|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED/.test(message)) {
        throw new DemoForgeError("APP_UNAVAILABLE", `The application at ${url} is not reachable.`, { cause: error });
      }
      if (/ERR_BLOCKED_BY_CLIENT/.test(message)) {
        throw new DemoForgeError("POLICY_VIOLATION", `Navigation to ${url} was blocked by the domain allow-list.`);
      }
      throw new DemoForgeError("WORKFLOW_FAILED", `Navigation to ${url} failed: ${message}`, { cause: error });
    }
    await this.settle();
    return { urlAfter: this.page.url() };
  }

  async click(target: Target, options?: ActionOptions): Promise<ActionOutcome> {
    const { locator, box, info } = await this.prepare("click", target, options);
    await this.moveCursorTo(box);
    await locator.click({ timeout: this.timeout(options) });
    this.recordClick();
    await this.settle();
    return { urlAfter: this.page.url(), box, elementName: info.name };
  }

  async fill(target: Target, value: string, options?: ActionOptions): Promise<ActionOutcome> {
    const { locator, box, info } = await this.prepare("fill", target, options);
    await this.moveCursorTo(box);
    if (this.presentation) {
      await locator.click({ timeout: this.timeout(options) });
      this.recordClick();
      await locator.fill("", { timeout: this.timeout(options) });
      await locator.pressSequentially(value, { delay: this.options.pacing.typingDelayMs });
    } else {
      await locator.fill(value, { timeout: this.timeout(options) });
    }
    return { urlAfter: this.page.url(), box, elementName: info.name };
  }

  async select(target: Target, value: string, options?: ActionOptions): Promise<ActionOutcome> {
    const { locator, box, info } = await this.prepare("select", target, options, value);
    await this.moveCursorTo(box);
    try {
      await locator.selectOption({ label: value }, { timeout: this.timeout(options) });
    } catch {
      await locator.selectOption(value, { timeout: this.timeout(options) });
    }
    this.recordClick();
    await this.settle();
    return { urlAfter: this.page.url(), box, elementName: info.name };
  }

  async setChecked(target: Target, checked: boolean, options?: ActionOptions): Promise<ActionOutcome> {
    const { locator, box, info } = await this.prepare(checked ? "check" : "uncheck", target, options);
    await this.moveCursorTo(box);
    await locator.setChecked(checked, { timeout: this.timeout(options) });
    this.recordClick();
    await this.settle();
    return { urlAfter: this.page.url(), box, elementName: info.name };
  }

  async hover(target: Target, options?: ActionOptions): Promise<ActionOutcome> {
    const { locator, box, info } = await this.prepare("hover", target, options);
    await this.moveCursorTo(box);
    await locator.hover({ timeout: this.timeout(options) });
    return { urlAfter: this.page.url(), box, elementName: info.name };
  }

  async scroll(options: { target?: Target; direction?: "up" | "down"; amount?: number }): Promise<ActionOutcome> {
    if (options.target) {
      const locator = await resolveLocator(this.page, options.target, this.options.actionTimeoutMs);
      await locator.scrollIntoViewIfNeeded();
      const box = (await locator.boundingBox()) ?? undefined;
      return { urlAfter: this.page.url(), box };
    }
    const amount = (options.amount ?? 600) * (options.direction === "up" ? -1 : 1);
    if (this.presentation) {
      const steps = 12;
      for (let i = 0; i < steps; i++) {
        await this.page.mouse.wheel(0, amount / steps);
        await sleep(25);
      }
    } else {
      await this.page.mouse.wheel(0, amount);
    }
    await sleep(250);
    return { urlAfter: this.page.url() };
  }

  async press(key: string, options?: ActionOptions): Promise<ActionOutcome> {
    const focused = await this.focusedElementInfo();
    const decision = this.options.guard.check("press", focused, key);
    if (!decision.allowed) throw new DemoForgeError("POLICY_VIOLATION", decision.reason ?? "Key press blocked.");
    await this.page.keyboard.press(key, { delay: this.presentation ? 60 : 0 });
    await this.settle(options);
    return { urlAfter: this.page.url() };
  }

  async wait(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async screenshot(path: string): Promise<string> {
    await this.page.screenshot({
      path,
      // Never capture password values, even if a field is unmasked by the app.
      mask: [this.page.locator('input[type="password"]')],
    });
    return path;
  }

  // ----------------------------------------------------------- verification

  async verify(expectation: Expectation, options?: ActionOptions): Promise<VerificationResult> {
    const timeout = this.timeout(options);
    const text = expectation.text ?? "";
    switch (expectation.type) {
      case "visible": {
        if (!expectation.target) return { ok: false, detail: "visible check needs a target" };
        try {
          await resolveLocator(this.page, expectation.target, timeout);
          return { ok: true, detail: `${describeTarget(expectation.target)} is visible` };
        } catch {
          return { ok: false, detail: `${describeTarget(expectation.target)} is not visible` };
        }
      }
      case "hidden": {
        if (!expectation.target) return { ok: false, detail: "hidden check needs a target" };
        const ok = await this.poll(async () => {
          try {
            await resolveLocator(this.page, expectation.target as Target, 200);
            return false;
          } catch {
            return true;
          }
        }, timeout);
        return { ok, detail: `${describeTarget(expectation.target)} is ${ok ? "hidden" : "still visible"}` };
      }
      case "text_present": {
        const ok = await this.poll(async () => (await this.bodyText()).includes(normalize(text)), timeout);
        return { ok, detail: ok ? `page shows "${text}"` : `page does not show "${text}"` };
      }
      case "text_absent": {
        const ok = await this.poll(async () => !(await this.bodyText()).includes(normalize(text)), timeout);
        return { ok, detail: ok ? `page no longer shows "${text}"` : `page still shows "${text}"` };
      }
      case "url_contains": {
        const ok = await this.poll(async () => this.page.url().includes(text), timeout);
        return { ok, detail: `url is ${this.page.url()}` };
      }
      case "title_contains": {
        const ok = await this.poll(async () => (await this.page.title()).includes(text), timeout);
        return { ok, detail: `title is "${await this.page.title()}"` };
      }
      case "value_equals": {
        if (!expectation.target) return { ok: false, detail: "value check needs a target" };
        const locator = await resolveLocator(this.page, expectation.target, timeout).catch(() => undefined);
        const value = locator ? await locator.inputValue().catch(() => undefined) : undefined;
        return { ok: value === expectation.value, detail: `value is "${value ?? "(not found)"}"` };
      }
      case "count_at_least": {
        if (!expectation.target) return { ok: false, detail: "count check needs a target" };
        const want = expectation.count ?? 1;
        let count = 0;
        const ok = await this.poll(async () => {
          count = await countMatches(this.page, expectation.target as Target);
          return count >= want;
        }, timeout);
        return { ok, detail: `found ${count}, wanted at least ${want}` };
      }
      case "custom": {
        if (!expectation.name || !this.options.customVerify) {
          return { ok: false, detail: `custom verification "${expectation.name ?? "?"}" is not available` };
        }
        const ok = await this.options.customVerify(expectation.name);
        return { ok, detail: `custom verification "${expectation.name}" ${ok ? "passed" : "failed"}` };
      }
    }
  }

  async evaluateCondition(condition: Condition): Promise<boolean> {
    switch (condition.type) {
      case "visible":
      case "not_visible": {
        if (!condition.target) return false;
        const visible = await resolveLocator(this.page, condition.target, 1500).then(() => true, () => false);
        return condition.type === "visible" ? visible : !visible;
      }
      case "url_contains":
        return this.page.url().includes(condition.text ?? "");
      case "text_present":
        return (await this.bodyText()).includes(normalize(condition.text ?? ""));
    }
  }

  async observe(maxChars = 14_000): Promise<PageObservation> {
    await this.settle();
    let snapshot = "";
    try {
      snapshot = await this.page.locator("body").ariaSnapshot({ timeout: 5000 });
    } catch {
      snapshot = (await this.page.locator("body").innerText().catch(() => "")).slice(0, maxChars);
    }
    const truncated = snapshot.length > maxChars;
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      snapshot: truncated ? `${snapshot.slice(0, maxChars)}\n... (truncated)` : snapshot,
      truncated,
    };
  }

  // ---------------------------------------------------------------- helpers

  private async prepare(
    action: "click" | "fill" | "select" | "check" | "uncheck" | "hover",
    target: Target,
    options?: ActionOptions,
    extraText = "",
  ): Promise<{ locator: Locator; box: Box | undefined; info: ElementInfo }> {
    const locator = await resolveLocator(this.page, target, this.timeout(options));
    await locator.scrollIntoViewIfNeeded({ timeout: this.timeout(options) }).catch(() => undefined);
    const info = await elementInfo(locator);
    const decision = this.options.guard.check(action, info, extraText);
    if (!decision.allowed) {
      throw new DemoForgeError("POLICY_VIOLATION", decision.reason ?? `${action} blocked by safety policy.`, {
        details: { target, category: decision.category },
      });
    }
    const box = (await locator.boundingBox()) ?? undefined;
    return { locator, box, info };
  }

  private async moveCursorTo(box: Box | undefined): Promise<void> {
    if (!box) return;
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (!this.presentation) {
      await this.page.mouse.move(to.x, to.y);
      this.mouse = to;
      return;
    }
    const from = { ...this.mouse };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const duration = Math.min(this.options.pacing.cursorMoveMs, 250 + distance * 0.6);
    const steps = Math.max(8, Math.round(duration / 16));
    for (let i = 1; i <= steps; i++) {
      const k = easeInOut(i / steps);
      const x = from.x + (to.x - from.x) * k;
      const y = from.y + (to.y - from.y) * k;
      await this.page.mouse.move(x, y);
      this.cursor.push({ t: this.now(), x, y });
      await sleep(duration / steps);
    }
    this.mouse = to;
    await sleep(120);
  }

  private recordClick(): void {
    this.cursor.push({ t: this.now(), x: this.mouse.x, y: this.mouse.y, click: true });
  }

  private async focusedElementInfo(): Promise<ElementInfo | undefined> {
    return this.page
      .evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return undefined;
        return {
          role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
          name: (el.getAttribute("aria-label") ?? (el as HTMLInputElement).value ?? el.innerText ?? "").slice(0, 120),
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") ?? undefined,
        };
      })
      .catch(() => undefined);
  }

  /** Wait briefly for the page to settle after an action without failing on long-polling apps. */
  private async settle(options?: ActionOptions): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: this.timeout(options) }).catch(() => undefined);
    await this.page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
  }

  private async bodyText(): Promise<string> {
    return normalize(await this.page.locator("body").innerText({ timeout: 2000 }).catch(() => ""));
  }

  private async poll(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await check().catch(() => false)) return true;
      await sleep(200);
    } while (Date.now() < deadline);
    return false;
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

async function countMatches(page: Page, target: Target): Promise<number> {
  const [first] = buildLocators(page, target);
  return first ? first.count() : 0;
}

async function elementInfo(locator: Locator): Promise<ElementInfo> {
  return locator.evaluate((el: Element) => {
    const html = el as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") ?? undefined;
    const implicit: Record<string, string> = {
      a: "link", button: "button", select: "combobox", textarea: "textbox", option: "option", summary: "button",
    };
    let role = el.getAttribute("role") ?? implicit[tag] ?? "generic";
    if (tag === "input") {
      role = ["submit", "button", "reset"].includes(type ?? "") ? "button" : type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : "textbox";
    }
    const labelled = el.getAttribute("aria-labelledby");
    const labelText = labelled ? document.getElementById(labelled)?.innerText : undefined;
    const name =
      el.getAttribute("aria-label") ??
      labelText ??
      (tag === "input" ? (el as HTMLInputElement).value || el.getAttribute("placeholder") : undefined) ??
      html.innerText ??
      el.getAttribute("title") ??
      "";
    return { role, name: String(name).replace(/\s+/g, " ").trim().slice(0, 160), tag, type };
  });
}
