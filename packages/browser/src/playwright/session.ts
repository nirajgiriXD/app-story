import { isAbsolute, join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { BrowserIssue, ProductConfig } from "@demoforge/contracts";
import { DemoForgeError, ensureDir, fileExists, requireEnv, type Logger } from "@demoforge/shared";
import { PlaywrightController } from "../controller/playwright-controller";
import { ActionGuard } from "../security/action-guard";
import { isAllowedUrl, resolveUrl } from "../security/url-guard";
import { CdpScreencastRecorder, type Recorder, type RecorderResult } from "../recording/cdp-recorder";
import { PlaywrightVideoRecorder } from "../recording/playwright-recorder";

export interface BrowserSessionOptions {
  config: ProductConfig;
  /** Product folder, used to resolve relative paths such as the storage state file. */
  productDir: string;
  /** Scratch folder for recordings and traces. */
  workDir: string;
  log: Logger;
  record?: boolean;
  fps?: number;
  headless?: boolean;
  /** `read_only` is used for discovery and production environments. */
  mode?: "normal" | "read_only";
  traceFile?: string;
  initBrowser?: (page: Page, context: BrowserContext) => Promise<void>;
  customVerify?: (name: string, page: Page, context: BrowserContext) => Promise<boolean>;
}

export interface BrowserSession {
  controller: PlaywrightController;
  page: Page;
  context: BrowserContext;
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

  let storageState: string | undefined;
  if (config.authentication.strategy === "storage_state") {
    const path = config.authentication.storage_state_path;
    storageState = isAbsolute(path) ? path : resolve(options.productDir, path);
    if (!(await fileExists(storageState))) {
      throw new DemoForgeError("AUTH_FAILED", `Saved login state not found at ${storageState}.`, {
        hint: `Run \`demoforge browser inspect --product ${config.product.id} --save-auth\` and log in once.`,
      });
    }
  }

  const browser: Browser = await chromium.launch({
    headless: options.headless ?? config.browser.headless,
    args: ["--hide-scrollbars", "--disable-features=Translate", "--force-color-profile=srgb"],
  });

  const recordWithPlaywright = options.record === true && engine === "playwright";
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    locale: config.browser.locale,
    timezoneId: config.browser.timezone,
    colorScheme: config.browser.color_scheme,
    storageState,
    acceptDownloads: false,
    serviceWorkers: "block",
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
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  }

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
    if (config.authentication.strategy === "form") {
      await formLogin(controller, page, config);
    }
    await controller.navigate(config.product.start_path);

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
    if (options.initBrowser) await options.initBrowser(page, context);

    const pageCreatedAt = Date.now();
    let recorder: Recorder | undefined;
    const activeController = controller;
    const activePage = page;

    return {
      controller: activeController,
      page: activePage,
      context,
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

async function formLogin(controller: PlaywrightController, page: Page, config: ProductConfig): Promise<void> {
  const auth = config.authentication;
  if (auth.strategy !== "form") return;
  const username = requireEnv(auth.username_env);
  const password = requireEnv(auth.password_env);
  await controller.navigate(auth.login_path);
  try {
    await page.getByLabel(auth.username_label).first().fill(username);
    await page.getByLabel(auth.password_label).first().fill(password);
    await page.getByRole("button", { name: auth.submit_text }).first().click();
    const loginUrl = resolveUrl(config.product.base_url, auth.login_path);
    await page.waitForURL(
      (url) => (auth.success_url_contains ? url.toString().includes(auth.success_url_contains) : url.toString() !== loginUrl),
      { timeout: config.browser.navigation_timeout_ms },
    );
  } catch (error) {
    throw new DemoForgeError("AUTH_FAILED", `Login at ${auth.login_path} did not succeed.`, {
      cause: error,
      hint: `Check ${auth.username_env}/${auth.password_env} in .env and the field labels in product.yaml.`,
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
