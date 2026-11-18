import type { Locator, Page, Request } from "playwright";
import { CAMERA_MOVE_MS, menuLayout, type Box, type BrowserIssue, type Condition, type CursorPoint, type Expectation, type Target } from "@app-story/contracts";
import { AppStoryError, sleep, type Logger } from "@app-story/shared";
import type { ActionOptions, ActionOutcome, BrowserController, PageObservation, VerificationResult } from "../types";
import { inPage } from "../playwright/in-page";
import { buildLocators, resolveLocator, describeTarget } from "../selectors/locator";
import type { ActionGuard, ElementInfo } from "../security/action-guard";
import { offLimitsElements } from "../security/off-limits";
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

/** How long a native dropdown's list stays open before the pointer moves to the option. */
export const MENU_OPEN_MS = 350;

/** Longest a value is typed key by key on camera; the rest is inserted at once. */
export const MAX_TYPING_MS = 2500;

/** The page counts as settled after this long without DOM changes or new requests. */
const QUIET_MS = 300;
/** Never wait longer than this for a page to settle (apps that never stop changing). */
const SETTLE_MAX_MS = 2500;
/** Requests open longer than this are long-polls or streams, not page loading. */
const LONG_REQUEST_MS = 2000;
/** Request types that mean the page is still loading what it will show. */
const LOADING_TYPES = new Set(["document", "xhr", "fetch", "script", "stylesheet"]);

export class PlaywrightController implements BrowserController {
  readonly issues: BrowserIssue[];
  readonly cursor: CursorPoint[] = [];
  readonly navigations: { t: number; url: string }[] = [];
  readonly scrolls: { start_ms: number; end_ms: number }[] = [];
  private origin = Date.now();
  private presentation = false;
  private mouse = { x: 0, y: 0 };
  /** The pointer's shape where it rests, as the page sets it. */
  private shape: CursorPoint["shape"] = "arrow";
  /** Requests in flight, with their start time, for `settle()`. */
  private readonly inflight = new Map<Request, number>();
  private settledAt = 0;

  constructor(
    readonly page: Page,
    private readonly options: PlaywrightControllerOptions,
  ) {
    this.issues = options.issues;
    const viewport = page.viewportSize();
    if (viewport) this.mouse = { x: viewport.width / 2, y: viewport.height / 2 };
    page.on("request", (r) => {
      if (LOADING_TYPES.has(r.resourceType())) this.inflight.set(r, Date.now());
    });
    const done = (r: Request) => this.inflight.delete(r);
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    // The address bar in the video changes when the page does, not when the step ends.
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && frame.url() !== this.navigations[this.navigations.length - 1]?.url) {
        this.navigations.push({ t: this.now(), url: frame.url() });
      }
    });
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
    this.navigations.length = 0;
    this.navigations.push({ t: this.now(), url: this.page.url() });
    this.scrolls.length = 0;
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
      throw new AppStoryError("POLICY_VIOLATION", `Navigation to ${url} is outside the allowed domains.`, {
        hint: "AppStory only visits the site in the product file's url, to keep demos on the product.",
      });
    }
    try {
      const response = await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options?.timeoutMs ?? this.options.navigationTimeoutMs,
      });
      if (response && response.status() >= 500) {
        throw new AppStoryError("APP_UNAVAILABLE", `${url} answered with HTTP ${response.status()}.`);
      }
    } catch (error) {
      if (error instanceof AppStoryError) throw error;
      const message = (error as Error).message;
      if (/ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_RESET|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED/.test(message)) {
        throw new AppStoryError("APP_UNAVAILABLE", `The application at ${url} is not reachable.`, { cause: error });
      }
      if (/ERR_BLOCKED_BY_CLIENT/.test(message)) {
        throw new AppStoryError("POLICY_VIOLATION", `Navigation to ${url} was blocked by the domain allow-list.`);
      }
      throw new AppStoryError("WORKFLOW_FAILED", `Navigation to ${url} failed: ${message}`, { cause: error });
    }
    await this.settle();
    return { urlAfter: this.page.url() };
  }

  async click(target: Target, options?: ActionOptions): Promise<ActionOutcome> {
    const { locator, box, region, info } = await this.prepare("click", target, options);
    await this.moveCursorTo(box);
    await locator.click({ timeout: this.timeout(options) });
    this.recordClick();
    await this.settle();
    return { urlAfter: this.page.url(), box, region, elementName: info.name };
  }

  async fill(target: Target, value: string, options?: ActionOptions): Promise<ActionOutcome> {
    const { locator, box, region, info } = await this.prepare("fill", target, options);
    await this.moveCursorTo(box);
    if (this.presentation) {
      await locator.click({ timeout: this.timeout(options) });
      this.recordClick();
      await locator.fill("", { timeout: this.timeout(options) });
      // Type at a natural pace, but never for long: a long value is typed in part, then the rest appears.
      const delay = this.options.pacing.typingDelayMs;
      const typed = delay > 0 && value.length * delay > MAX_TYPING_MS ? value.slice(0, Math.floor(MAX_TYPING_MS / delay)) : value;
      await locator.pressSequentially(typed, { delay });
      if (typed.length < value.length) await this.page.keyboard.insertText(value.slice(typed.length));
    } else {
      await locator.fill(value, { timeout: this.timeout(options) });
    }
    return { urlAfter: this.page.url(), box, region, elementName: info.name };
  }

  async select(target: Target, value: string, options?: ActionOptions): Promise<ActionOutcome> {
    const { locator, box, region, info } = await this.prepare("select", target, options, value);
    await this.moveCursorTo(box);
    // A native dropdown's list is drawn by the browser outside the page, so the recording
    // would only show the value jump. On camera, the pointer opens it, moves to the option and
    // picks it; the video draws the list from what is noted here (see `menuLayout`).
    const native = this.presentation && box ? await nativeOptions(locator) : undefined;
    let opened = 0;
    if (native && box) {
      this.recordClick();
      opened = this.now();
      await sleep(MENU_OPEN_MS);
    }
    const to = native ? native.options.findIndex((o) => o === value || o.trim() === value.trim()) : -1;
    if (native && box && to >= 0) {
      const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 };
      const list = menuLayout(box, { options: native.options, to }, viewport);
      const row = { x: list.x + 8, y: list.y + 4 + (to - list.first) * list.rowHeight, width: Math.min(list.width, box.width) - 16, height: list.rowHeight };
      // A list's rows show the arrow, whatever is on the page under the drawn list.
      await this.moveCursorTo(row, { shape: "arrow" });
    }
    try {
      await locator.selectOption({ label: value }, { timeout: this.timeout(options) });
    } catch {
      await locator.selectOption(value, { timeout: this.timeout(options) });
    }
    this.recordClick();
    let menu: ActionOutcome["menu"];
    if (native) {
      const chosen = await locator.evaluate(inPage((el: Element) => (el as HTMLSelectElement).selectedIndex)).catch(() => to);
      menu = { options: native.options, from: native.selected, to: chosen, opened_ms: opened, closed_ms: this.now() };
    }
    await this.settle();
    return { urlAfter: this.page.url(), box, region, elementName: info.name, menu };
  }

  async setChecked(target: Target, checked: boolean, options?: ActionOptions): Promise<ActionOutcome> {
    const { locator, box, region, info } = await this.prepare(checked ? "check" : "uncheck", target, options);
    await this.moveCursorTo(box);
    await locator.setChecked(checked, { timeout: this.timeout(options) });
    this.recordClick();
    await this.settle();
    return { urlAfter: this.page.url(), box, region, elementName: info.name };
  }

  async hover(target: Target, options?: ActionOptions): Promise<ActionOutcome> {
    const { locator, box, region, info } = await this.prepare("hover", target, options);
    await this.moveCursorTo(box);
    await locator.hover({ timeout: this.timeout(options) });
    return { urlAfter: this.page.url(), box, region, elementName: info.name };
  }

  async scroll(options: { target?: Target; direction?: "up" | "down"; amount?: number }): Promise<ActionOutcome> {
    if (options.target) {
      const locator = await resolveLocator(this.page, options.target, this.options.actionTimeoutMs);
      await this.bringIntoView(locator, this.options.actionTimeoutMs);
      const box = (await locator.boundingBox()) ?? undefined;
      return { urlAfter: this.page.url(), box };
    }
    const amount = (options.amount ?? 600) * (options.direction === "up" ? -1 : 1);
    if (this.presentation) {
      await this.onCamera(async () => {
        const steps = 12;
        for (let i = 0; i < steps; i++) {
          await this.page.mouse.wheel(0, amount / steps);
          await sleep(25);
        }
        await sleep(250);
      });
    } else {
      await this.page.mouse.wheel(0, amount);
      await sleep(250);
    }
    return { urlAfter: this.page.url() };
  }

  async press(key: string, options?: ActionOptions): Promise<ActionOutcome> {
    const focused = await this.focusedElementInfo();
    const decision = this.options.guard.check("press", focused, key);
    if (!decision.allowed) throw new AppStoryError("POLICY_VIOLATION", decision.reason ?? "Key press blocked.");
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
    const result = await this.check(expectation, options);
    if (!result.ok) return result;
    // Where the outcome is on screen, so the video can show it.
    const where = await this.locateOutcome(expectation).catch(() => undefined);
    return where ? { ...result, ...where } : result;
  }

  /** The element an expectation is about, if it is one visible element. */
  private async locateOutcome(expectation: Expectation): Promise<{ box: Box; region?: Box } | undefined> {
    let locator: Locator | undefined;
    if (expectation.target && ["visible", "value_equals", "count_at_least"].includes(expectation.type)) {
      locator = (await resolveLocator(this.page, expectation.target, 1000)).first();
    } else if (expectation.type === "text_present" && expectation.text) {
      locator = this.page.getByText(expectation.text).first();
    }
    if (!locator || !(await locator.isVisible().catch(() => false))) return undefined;
    const box = await locator.boundingBox();
    if (!box) return undefined;
    return { box, region: await regionOf(locator) };
  }

  private async check(expectation: Expectation, options?: ActionOptions): Promise<VerificationResult> {
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
        const visible = await resolveLocator(this.page, condition.target, 1500).then(
          () => true,
          () => false,
        );
        return condition.type === "visible" ? visible : !visible;
      }
      case "url_contains":
        return this.page.url().includes(condition.text ?? "");
      case "text_present":
        return (await this.bodyText()).includes(normalize(condition.text ?? ""));
    }
  }

  async observe(maxChars = 14_000): Promise<PageObservation> {
    // An action that just finished has already waited for the page.
    if (Date.now() - this.settledAt > 100) await this.settle();
    let snapshot = "";
    try {
      snapshot = await this.page.locator("body").ariaSnapshot({ timeout: 5000 });
    } catch {
      snapshot = (
        await this.page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, maxChars);
    }
    const truncated = snapshot.length > maxChars;
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      snapshot: truncated ? `${snapshot.slice(0, maxChars)}\n... (truncated)` : snapshot,
      truncated,
      offLimits: offLimitsElements(snapshot, this.options.guard),
    };
  }

  // ---------------------------------------------------------------- helpers

  private async prepare(
    action: "click" | "fill" | "select" | "check" | "uncheck" | "hover",
    target: Target,
    options?: ActionOptions,
    extraText = "",
  ): Promise<{ locator: Locator; box: Box | undefined; region: Box | undefined; info: ElementInfo }> {
    const locator = await resolveLocator(this.page, target, this.timeout(options));
    await this.bringIntoView(locator, this.timeout(options));
    const info = await elementInfo(locator);
    const decision = this.options.guard.check(action, info, extraText);
    if (!decision.allowed) {
      throw new AppStoryError("POLICY_VIOLATION", decision.reason ?? `${action} blocked by safety policy.`, {
        details: { target, category: decision.category },
      });
    }
    const box = (await locator.boundingBox()) ?? undefined;
    const region = await regionOf(locator);
    return { locator, box, region, info };
  }

  /** `shape` names the pointer's shape where it lands, when the page under it is not what is shown (a drawn list). */
  private async moveCursorTo(box: Box | undefined, landing?: { shape: NonNullable<CursorPoint["shape"]> }): Promise<void> {
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
    const bend = curveControl(from, to);
    for (let i = 1; i <= steps; i++) {
      const k = easeInOut(i / steps);
      // A gentle arc, as a hand moves a mouse, rather than a ruler-straight line.
      const x = (1 - k) * (1 - k) * from.x + 2 * (1 - k) * k * bend.x + k * k * to.x;
      const y = (1 - k) * (1 - k) * from.y + 2 * (1 - k) * k * bend.y + k * k * to.y;
      await this.page.mouse.move(x, y);
      // While it travels the pointer is an arrow; where it lands, it takes the page's shape.
      this.cursor.push({ t: this.now(), x, y, ...(i === 1 ? { shape: "arrow" as const } : {}) });
      await sleep(duration / steps);
    }
    this.mouse = to;
    this.shape = landing?.shape ?? (await this.pointerShapeAt(to));
    const last = this.cursor[this.cursor.length - 1];
    if (last && this.shape !== "arrow") last.shape = this.shape;
    await sleep(120);
  }

  /** The pointer the page shows at a point: a hand over links and buttons, a text bar over text. */
  private async pointerShapeAt(at: { x: number; y: number }): Promise<CursorPoint["shape"]> {
    return this.page
      .evaluate(
        inPage(({ x, y }: { x: number; y: number }) => {
          const el = document.elementFromPoint(x, y) as HTMLElement | null;
          if (!el) return "arrow" as const;
          const cursor = getComputedStyle(el).cursor;
          if (cursor === "pointer") return "hand" as const;
          if (cursor === "text" || cursor === "vertical-text") return "text" as const;
          if (cursor !== "auto") return "arrow" as const;
          // `auto`: the browser shows a text bar over editable text, an arrow elsewhere.
          const editable =
            el.isContentEditable ||
            el instanceof HTMLTextAreaElement ||
            (el instanceof HTMLInputElement && !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"].includes(el.type));
          return editable ? ("text" as const) : ("arrow" as const);
        }),
        at,
      )
      .catch(() => "arrow" as const);
  }

  private recordClick(): void {
    this.cursor.push({ t: this.now(), x: this.mouse.x, y: this.mouse.y, click: true, ...(this.shape !== "arrow" ? { shape: this.shape } : {}) });
  }

  private async focusedElementInfo(): Promise<ElementInfo | undefined> {
    return this.page
      .evaluate(
        inPage(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return undefined;
          return {
            role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
            name: (el.getAttribute("aria-label") ?? (el as HTMLInputElement).value ?? el.innerText ?? "").slice(0, 120),
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type") ?? undefined,
          };
        }),
      )
      .catch(() => undefined);
  }

  /**
   * Wait until the page stops changing: no DOM mutations and no new loading requests for
   * QUIET_MS, capped at SETTLE_MAX_MS. `networkidle` is no use here: in a single-page app it
   * fired long ago, so it returns before the click's data arrives; in an app that polls it
   * never fires, so every action would wait the full cap.
   */
  private async settle(options?: ActionOptions): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: this.timeout(options) }).catch(() => undefined);
    const deadline = Date.now() + SETTLE_MAX_MS;
    while (Date.now() < deadline) {
      const quiet = await this.page.evaluate(inPage(waitForDomQuiet), { quietMs: QUIET_MS, maxMs: deadline - Date.now() }).then(
        () => true,
        () => false,
      );
      if (!quiet) {
        // The page navigated mid-wait; wait for the new document, then check again.
        await this.page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, deadline - Date.now()) }).catch(() => undefined);
        await sleep(50);
        continue;
      }
      if (!this.loading()) break;
      await sleep(100);
    }
    this.settledAt = Date.now();
  }

  /** True while a request the page is waiting for (not a long-poll) is in flight. */
  private loading(): boolean {
    const now = Date.now();
    let loading = false;
    for (const [request, started] of this.inflight) {
      if (now - started < LONG_REQUEST_MS) loading = true;
      else if (now - started > 60_000) this.inflight.delete(request); // never finished; stop tracking it
    }
    return loading;
  }

  /**
   * Make sure the element is on screen. On camera it glides into the middle of the view
   * instead of jumping, which also frames it well for the zoom.
   */
  private async bringIntoView(locator: Locator, timeoutMs: number): Promise<void> {
    if (this.presentation) {
      const off = await locator
        .evaluate(
          inPage((el: Element) => {
            const r = el.getBoundingClientRect();
            return r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth;
          }),
        )
        .catch(() => false);
      if (off) {
        await this.onCamera(async () => {
          await locator.evaluate(inPage((el: Element) => el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }))).catch(() => undefined);
          await this.waitForStill(locator);
        });
      }
    }
    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
  }

  /**
   * A scroll on camera: the video's camera first pulls back (one move), the page scrolls while
   * it is wide, and it pushes in again (one more move) before anything else happens. The scroll
   * is noted, so the camera and the highlight hold still while the page moves.
   */
  private async onCamera(scroll: () => Promise<void>): Promise<void> {
    await sleep(CAMERA_MOVE_MS);
    const start = this.now();
    await scroll();
    this.scrolls.push({ start_ms: start, end_ms: this.now() });
    await sleep(CAMERA_MOVE_MS);
  }

  /** Wait (up to 1.5s) until a smooth scroll has stopped moving the element. */
  private async waitForStill(locator: Locator): Promise<void> {
    const deadline = Date.now() + 1500;
    let last: Box | null = null;
    while (Date.now() < deadline) {
      await sleep(80);
      const box = await locator.boundingBox().catch(() => null);
      if (box && last && Math.abs(box.y - last.y) < 0.5 && Math.abs(box.x - last.x) < 0.5) return;
      last = box;
    }
  }

  private async bodyText(): Promise<string> {
    return normalize(
      await this.page
        .locator("body")
        .innerText({ timeout: 2000 })
        .catch(() => ""),
    );
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

/** A native single-choice dropdown's option labels and selected index; undefined for anything else. */
async function nativeOptions(locator: Locator): Promise<{ options: string[]; selected: number } | undefined> {
  const found = await locator
    .evaluate(
      inPage((el: Element) => {
        if (!(el instanceof HTMLSelectElement) || el.multiple || el.size > 1) return null;
        return { options: Array.from(el.options, (o) => (o.label || o.text).replace(/\s+/g, " ").trim()), selected: el.selectedIndex };
      }),
    )
    .catch(() => null);
  return found && found.options.length > 0 ? found : undefined;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

async function countMatches(page: Page, target: Target): Promise<number> {
  const [first] = buildLocators(page, target);
  return first ? first.count() : 0;
}

async function elementInfo(locator: Locator): Promise<ElementInfo> {
  return locator.evaluate(
    inPage((el: Element) => {
      const html = el as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") ?? undefined;
      const implicit: Record<string, string> = {
        a: "link",
        button: "button",
        select: "combobox",
        textarea: "textbox",
        option: "option",
        summary: "button",
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
    }),
  );
}

/** Runs in the page: resolves once the DOM has not changed for `quietMs` (or after `maxMs`). */
function waitForDomQuiet({ quietMs, maxMs }: { quietMs: number; maxMs: number }): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(finish, quietMs);
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(finish, quietMs);
    const cap = setTimeout(finish, maxMs);
  });
}

/**
 * The middle point of a pointer move's arc: off the straight line by a tenth of its length,
 * always bowing upward (a wrist pivots, so moves curve the same way). Viewport px.
 */
export function curveControl(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number } {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return mid;
  // The normal that points up the screen.
  let nx = -dy / length;
  let ny = dx / length;
  if (ny > 0) [nx, ny] = [-nx, -ny];
  const offset = Math.min(80, length * 0.1);
  return { x: mid.x + nx * offset, y: mid.y + ny * offset };
}

/**
 * The area an element belongs to, the way an editor would frame it: the largest form,
 * card, dialog, table or other visible container around it that is still well under half
 * the screen. Undefined when the element stands on its own. Viewport CSS pixels.
 */
async function regionOf(locator: Locator): Promise<Box | undefined> {
  const region = await locator
    .evaluate(
      inPage((el: Element) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const semantic = new Set(["FORM", "FIELDSET", "DIALOG", "TABLE", "SECTION", "ARTICLE", "ASIDE", "NAV", "UL", "OL", "HEADER", "FOOTER"]);
        const roles = new Set([
          "dialog",
          "alertdialog",
          "form",
          "region",
          "group",
          "table",
          "grid",
          "list",
          "listbox",
          "menu",
          "toolbar",
          "alert",
          "status",
          "tabpanel",
          "navigation",
          "banner",
          "row",
        ]);
        const transparent = (c: string) => c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);
        const own = el.getBoundingClientRect();
        let best: DOMRect | undefined;
        for (let e = el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
          const r = e.getBoundingClientRect();
          const visible = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
          if (visible > vw * vh * 0.45) break;
          if (r.width * r.height < own.width * own.height * 1.3) continue;
          const style = getComputedStyle(e);
          const boxed =
            style.boxShadow !== "none" ||
            (Number.parseFloat(style.borderTopWidth) > 0 && Number.parseFloat(style.borderLeftWidth) > 0 && !transparent(style.borderTopColor)) ||
            (!transparent(style.backgroundColor) && e.parentElement !== null && style.backgroundColor !== getComputedStyle(e.parentElement).backgroundColor);
          if (semantic.has(e.tagName) || roles.has(e.getAttribute("role") ?? "") || boxed) best = r;
        }
        if (!best) return undefined;
        const x = Math.max(0, best.left);
        const y = Math.max(0, best.top);
        return { x, y, width: Math.min(best.right, vw) - x, height: Math.min(best.bottom, vh) - y };
      }),
    )
    .catch(() => undefined);
  return region && region.width > 0 && region.height > 0 ? region : undefined;
}
