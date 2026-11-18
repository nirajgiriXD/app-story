import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { BrowserIssue, ProductConfig } from "@app-story/contracts";
import { AppStoryError, ensureDir, resolveCredential, type Logger } from "@app-story/shared";
import { PlaywrightController } from "../controller/playwright-controller";
import { inPage } from "./in-page";

import { ActionGuard } from "../security/action-guard";
import { isAllowedUrl } from "../security/url-guard";
import { CdpScreencastRecorder, type Recorder, type RecorderResult } from "../recording/cdp-recorder";
import { PlaywrightVideoRecorder } from "../recording/playwright-recorder";

/** Cookies and local storage of a logged-in browser (kept in memory only, never written to disk). */
export type LoginState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface BrowserSessionOptions {
  config: ProductConfig;
  /** Scratch folder for recordings and traces. */
  workDir: string;
  log: Logger;
  record?: boolean;
  fps?: number;
  headless?: boolean;
  /** `read_only` blocks typing, selecting and button clicks (production environments). */
  mode?: "normal" | "read_only";
  traceFile?: string;
  /** Login from an earlier session of the same job: skips the login form while it still works. */
  loginState?: LoginState;
  initBrowser?: (page: Page, context: BrowserContext) => Promise<void>;
  customVerify?: (name: string, page: Page, context: BrowserContext) => Promise<boolean>;
}

export interface BrowserSession {
  controller: PlaywrightController;
  page: Page;
  context: BrowserContext;
  /** The state right after logging in, for the job's next session (undefined without a login). */
  loginState?: LoginState;
  startRecording(): Promise<number>;
  stopRecording(outputPath: string): Promise<RecorderResult>;
  saveStorageState(path: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Launch Chromium with an isolated context for one job: viewport, locale, auth,
 * domain allow-list, popup and dialog handling, console and network error collection.
 */
export async function launchBrowserSession(options: BrowserSessionOptions): Promise<BrowserSession> {
  const { config, log } = options;
  const { viewport, device_scale_factor: deviceScaleFactor } = config.browser;
  const engine = config.recording.engine;
  const fps = options.fps ?? config.demo.fps;
  await ensureDir(options.workDir);

  const headless = options.headless ?? config.browser.headless;
  const browser: Browser = await chromium.launch({
    headless,
    args: browserArgs(deviceScaleFactor, headless),
  });

  const recordWithPlaywright = options.record === true && engine === "playwright";
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    locale: config.browser.locale,
    timezoneId: config.browser.timezone,
    colorScheme: config.browser.color_scheme,
    acceptDownloads: false,
    serviceWorkers: "block",
    storageState: config.authentication.strategy === "auto" ? options.loginState : undefined,
    recordVideo: recordWithPlaywright ? { dir: join(options.workDir, "pw-video"), size: viewport } : undefined,
  });
  context.setDefaultTimeout(config.browser.action_timeout_ms);
  context.setDefaultNavigationTimeout(config.browser.navigation_timeout_ms);

  const issues: BrowserIssue[] = [];
  const at = () => new Date().toISOString();
  const allowed = config.browser.allowed_domains;

  // Domain allow-list: block any frame navigation that leaves the allowed hosts.
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && !isAllowedUrl(request.url(), allowed)) {
      issues.push({ kind: "blocked_navigation", message: "Navigation outside allowed domains was blocked.", url: request.url(), at: at() });
      log.warn({ url: request.url() }, "blocked navigation outside allowed domains");
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });

  if (options.traceFile) {
    // Trace screenshots run a second screencast next to the recorder and cost it frames,
    // so the take being recorded keeps only DOM snapshots (failure screenshots are separate).
    await context.tracing.start({ screenshots: !options.record, snapshots: true, sources: false });
  }

  const blurred = config.browser.blur.join(", ");
  if (blurred) await context.addInitScript(inPage(blurInPage), blurCss(blurred));

  let page = await context.newPage();
  attachCollectors(page, issues, log);

  // Demos stay in one tab; popups are closed and logged.
  context.on("page", async (popup) => {
    if (popup === page) return;
    issues.push({ kind: "blocked_navigation", message: "A new tab/popup was opened and closed.", url: popup.url(), at: at() });
    await popup.close().catch(() => undefined);
  });

  const guard = new ActionGuard(config.safety, options.mode ?? "normal");
  const makeController = (p: Page) =>
    new PlaywrightController(p, {
      baseUrl: config.product.base_url,
      allowedDomains: allowed,
      actionTimeoutMs: config.browser.action_timeout_ms,
      navigationTimeoutMs: config.browser.navigation_timeout_ms,
      guard,
      log,
      pacing: { cursorMoveMs: config.recording.cursor_move_ms, typingDelayMs: config.recording.typing_delay_ms },
      issues,
      customVerify: options.customVerify ? (name) => options.customVerify!(name, p, context) : undefined,
    });

  const closeAll = async () => {
    if (options.traceFile) await context.tracing.stop({ path: options.traceFile }).catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  };

  try {
    let controller = makeController(page);
    let loginState: LoginState | undefined;
    if (config.authentication.strategy === "auto") {
      // Reuse the job's login when it still works: no login form, no waiting for redirects.
      if (options.loginState && (await stillLoggedIn(controller, page, config))) {
        loginState = options.loginState;
      } else {
        await autoLogin(controller, page, config);
        loginState = await context.storageState();
        await controller.navigate(config.product.start_path);
      }
    } else {
      await controller.navigate(config.product.start_path);
    }

    if (recordWithPlaywright) {
      // Playwright records from page creation, so start a fresh page after login.
      const fresh = await context.newPage();
      attachCollectors(fresh, issues, log);
      const oldPage = page;
      page = fresh;
      await oldPage.close();
      controller = makeController(page);
      await controller.navigate(config.product.start_path);
    }
    if (blurred) await checkBlurSelectors(page, config.browser.blur);
    if (options.initBrowser) await options.initBrowser(page, context);

    const pageCreatedAt = Date.now();
    let recorder: Recorder | undefined;
    const activeController = controller;
    const activePage = page;

    return {
      controller: activeController,
      page: activePage,
      context,
      loginState,
      async startRecording() {
        recorder =
          engine === "cdp"
            ? new CdpScreencastRecorder(activePage, options.workDir, {
                width: viewport.width * deviceScaleFactor,
                height: viewport.height * deviceScaleFactor,
                fps,
                quality: config.recording.jpeg_quality,
                log,
              })
            : new PlaywrightVideoRecorder(activePage, pageCreatedAt, { width: viewport.width, height: viewport.height, fps });
        await recorder.start();
        activeController.setClockOrigin(recorder.startedAt);
        return recorder.startedAt;
      },
      async stopRecording(outputPath: string) {
        if (!recorder) throw new Error("Recording was not started.");
        return recorder.stop(outputPath);
      },
      async saveStorageState(path: string) {
        await ensureDir(resolve(path, ".."));
        await context.storageState({ path });
      },
      close: closeAll,
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}

/**
 * Chromium's flags for a session. The context's `deviceScaleFactor` alone makes the page
 * lay out at 2x, but the screencast still sends frames at 1x (1600x900 for a 1600x900 view
 * at 2x), which FFmpeg would only stretch. Forcing the same scale on the whole headless
 * browser makes its frames really 2x. A headed browser is left alone: its window would grow.
 */
export function browserArgs(deviceScaleFactor: number, headless: boolean): string[] {
  const args = ["--hide-scrollbars", "--disable-features=Translate", "--force-color-profile=srgb"];
  if (headless && deviceScaleFactor !== 1) args.push(`--force-device-scale-factor=${deviceScaleFactor}`);
  return args;
}

/** Open the start page with a saved login; true if the app did not ask to log in again. */
async function stillLoggedIn(controller: PlaywrightController, page: Page, config: ProductConfig): Promise<boolean> {
  const opened = await controller.navigate(config.product.start_path).then(
    () => true,
    () => false,
  );
  if (!opened) return false;
  return !(await page
    .locator('input[type="password"]:visible')
    .first()
    .isVisible()
    .catch(() => false));
}

/** Paths tried, in order, when the start page shows no login form and none is configured. */
const COMMON_LOGIN_PATHS = ["/login", "/signin", "/sign-in", "/users/sign_in", "/auth/login", "/account/login"];

/** Text-like inputs that can hold a username or email. */
const USERNAME_FIELD = [
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[type="text"]',
  "input:not([type])",
].map((s) => `${s}:visible`);

/**
 * Log in through the app's own form, without being told its field names: find the page
 * with a password field (the start page, the configured login page, or a common path),
 * fill the username and password, submit with Enter, and wait for the form to go away.
 */
async function autoLogin(controller: PlaywrightController, page: Page, config: ProductConfig): Promise<void> {
  const auth = config.authentication;
  if (auth.strategy !== "auto") return;
  const where = `the login in products/${config.product.id}.md`;
  const username = resolveCredential(auth.username, { secret: false, hint: `It is used by ${where}.` });
  const password = resolveCredential(auth.password, { secret: true, hint: `It is used by ${where}.` });
  const passwordField = page.locator('input[type="password"]:visible').first();
  const formVisible = (timeout: number) =>
    passwordField
      .waitFor({ state: "visible", timeout })
      .then(() => true)
      .catch(() => false);

  const candidates = auth.login_path ? [auth.login_path] : [config.product.start_path, ...COMMON_LOGIN_PATHS];
  let found = false;
  for (const [i, path] of candidates.entries()) {
    const opened = await controller.navigate(path).then(
      () => true,
      () => false,
    );
    // The start page usually redirects to the login form; give it time to appear.
    if (opened && (await formVisible(i === 0 ? 5_000 : 2_000))) {
      found = true;
      break;
    }
  }
  if (!found) {
    throw new AppStoryError("AUTH_FAILED", `Could not find a login form for ${config.product.name}.`, {
      hint: `Add the page that shows it, e.g. "login page: /login", to products/${config.product.id}.md.`,
    });
  }

  try {
    const usernameField = page.locator(USERNAME_FIELD.join(", ")).first();
    if (await usernameField.count()) await usernameField.fill(username);
    await passwordField.fill(password);
    await passwordField.press("Enter");
    await passwordField.waitFor({ state: "hidden", timeout: config.browser.navigation_timeout_ms });
  } catch (error) {
    throw new AppStoryError("AUTH_FAILED", `Logging in to ${config.product.name} did not work.`, {
      cause: error,
      hint: `Check ${where}. Two-step logins (email first, password on a second page) are not supported yet.`,
    });
  }
}

function attachCollectors(page: Page, issues: BrowserIssue[], log: Logger): void {
  const at = () => new Date().toISOString();
  page.on("console", (msg) => {
    if (msg.type() === "error") issues.push({ kind: "console_error", message: msg.text().slice(0, 500), url: page.url(), at: at() });
  });
  page.on("pageerror", (err) => issues.push({ kind: "page_error", message: err.message.slice(0, 500), url: page.url(), at: at() }));
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "failed";
    if (failure.includes("ERR_ABORTED") || failure.includes("BLOCKED_BY_CLIENT")) return;
    issues.push({ kind: "request_failed", message: `${req.method()} ${failure}`, url: req.url(), at: at() });
  });
  page.on("response", (res) => {
    if (res.status() >= 500) issues.push({ kind: "http_error", message: `HTTP ${res.status()}`, url: res.url(), at: at() });
  });
  // Native dialogs (alert/confirm) are dismissed: confirming is usually the risky choice.
  page.on("dialog", async (dialog) => {
    log.warn({ type: dialog.type(), message: dialog.message() }, "dismissed a browser dialog");
    await dialog.dismiss().catch(() => undefined);
  });
}

/** The style that blurs the product file's `blur:` selectors: unreadable, but the layout stays. */
export function blurCss(selectors: string): string {
  return `${selectors} { filter: blur(10px) !important; }`;
}

/**
 * Runs in every page before its own scripts: adds the blur style as a constructed style
 * sheet, which the page's own markup cannot remove, and adds it again if the page replaced
 * the document's sheets while loading.
 */
function blurInPage(css: string): void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const ensure = () => {
    if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  };
  ensure();
  document.addEventListener("DOMContentLoaded", ensure);
  window.addEventListener("load", ensure);
}

/**
 * A selector the browser cannot read would make the whole blur rule silently do nothing,
 * so each one is tried in the page first; a broken one stops the job before anything is recorded.
 */
async function checkBlurSelectors(page: Page, selectors: readonly string[]): Promise<void> {
  for (const selector of selectors) {
    const valid = await page.evaluate(
      inPage((s: string) => {
        try {
          document.querySelector(s);
          return true;
        } catch {
          return false;
        }
      }),
      selector,
    );
    if (!valid) {
      throw new AppStoryError("CONFIG_INVALID", `blur: '${selector}' is not a CSS selector the browser understands.`, {
        hint: "Use CSS selectors, e.g. blur: .api-key, #customer-email, [data-private]",
      });
    }
  }
}
