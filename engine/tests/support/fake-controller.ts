import type { BrowserIssue, Condition, CursorPoint, Expectation, Target } from "@showrun/contracts";
import type { ActionOutcome, BrowserController, PageObservation, VerificationResult } from "@showrun/browser";
import { ShowrunError } from "@showrun/shared";

/**
 * In-memory browser for unit tests. Elements are identified by their accessible name
 * (or label/text); `texts` is what `text_present` sees.
 */
export class FakeController implements BrowserController {
  readonly baseUrl = "http://app.test";
  readonly issues: BrowserIssue[] = [];
  readonly cursor: CursorPoint[] = [];
  readonly actions: string[] = [];
  url = "http://app.test/";
  texts = new Set<string>();
  elements = new Set<string>(["New project", "Project name", "Create project"]);
  /** Element names that fail the first N times they are used. */
  flaky = new Map<string, number>();
  private time = 0;

  now(): number {
    return this.time;
  }
  setClockOrigin(): void {
    this.time = 0;
  }
  setPresentationMode(): void {}
  currentUrl(): string {
    return this.url;
  }

  private find(target: Target): string {
    const key = target.name ?? target.label ?? target.text ?? target.css ?? "";
    const failures = this.flaky.get(key) ?? 0;
    if (failures > 0) {
      this.flaky.set(key, failures - 1);
      throw new ShowrunError("WORKFLOW_FAILED", `flaky ${key}`);
    }
    if (!this.elements.has(key)) throw new ShowrunError("WORKFLOW_FAILED", `Could not find ${key}`);
    return key;
  }

  private act(name: string): ActionOutcome {
    this.time += 100;
    this.actions.push(name);
    return { urlAfter: this.url, box: { x: 10, y: 10, width: 100, height: 30 } };
  }

  async navigate(path: string): Promise<ActionOutcome> {
    this.url = new URL(path, this.baseUrl).toString();
    return this.act(`navigate ${path}`);
  }
  async click(target: Target): Promise<ActionOutcome> {
    const key = this.find(target);
    if (key === "Create project") this.texts.add("Project created");
    return this.act(`click ${key}`);
  }
  async fill(target: Target, value: string): Promise<ActionOutcome> {
    return this.act(`fill ${this.find(target)}=${value}`);
  }
  async select(target: Target, value: string): Promise<ActionOutcome> {
    return this.act(`select ${this.find(target)}=${value}`);
  }
  async setChecked(target: Target, checked: boolean): Promise<ActionOutcome> {
    return this.act(`check ${this.find(target)}=${checked}`);
  }
  async hover(target: Target): Promise<ActionOutcome> {
    return this.act(`hover ${this.find(target)}`);
  }
  async scroll(): Promise<ActionOutcome> {
    return this.act("scroll");
  }
  async press(key: string): Promise<ActionOutcome> {
    return this.act(`press ${key}`);
  }
  async wait(ms: number): Promise<void> {
    this.time += ms;
  }
  async screenshot(path: string): Promise<string> {
    return path;
  }
  async verify(expectation: Expectation): Promise<VerificationResult> {
    if (expectation.type === "text_present") {
      const ok = this.texts.has(expectation.text ?? "");
      return { ok, detail: ok ? "found" : "missing" };
    }
    if (expectation.type === "url_contains") return { ok: this.url.includes(expectation.text ?? ""), detail: this.url };
    if (expectation.type === "visible" && expectation.target) {
      const key = expectation.target.name ?? expectation.target.label ?? "";
      return { ok: this.elements.has(key), detail: key };
    }
    return { ok: false, detail: "unsupported in fake" };
  }
  async evaluateCondition(condition: Condition): Promise<boolean> {
    if (condition.type === "visible") return this.elements.has(condition.target?.name ?? "");
    if (condition.type === "not_visible") return !this.elements.has(condition.target?.name ?? "");
    return this.url.includes(condition.text ?? "");
  }
  async observe(): Promise<PageObservation> {
    return { url: this.url, title: "Fake", snapshot: [...this.elements].map((e) => `- button "${e}"`).join("\n"), truncated: false };
  }
}
