import type { Box, BrowserIssue, Condition, CursorPoint, Expectation, Target } from "@showrun/contracts";

export interface PageObservation {
  url: string;
  title: string;
  /** Accessibility-tree snapshot (YAML-like). Untrusted page content. */
  snapshot: string;
  truncated: boolean;
}

export interface ActionOutcome {
  urlAfter: string;
  /** Element box in viewport CSS pixels, measured before the action. */
  box?: Box;
  elementName?: string;
}

export interface VerificationResult {
  ok: boolean;
  detail: string;
}

export interface ActionOptions {
  timeoutMs?: number;
  /** Mask the value in logs. */
  secret?: boolean;
}

/**
 * Engine-neutral browser operations. The workflow executor and the AI tools only talk
 * to this interface; Playwright is one implementation.
 */
export interface BrowserController {
  readonly baseUrl: string;
  readonly issues: BrowserIssue[];
  readonly cursor: CursorPoint[];
  /** Milliseconds since the clock origin (recording start). */
  now(): number;
  setClockOrigin(epochMs: number): void;
  /** Slow, human-like movement and typing for the recorded take. */
  setPresentationMode(enabled: boolean): void;

  navigate(urlOrPath: string, options?: ActionOptions): Promise<ActionOutcome>;
  click(target: Target, options?: ActionOptions): Promise<ActionOutcome>;
  fill(target: Target, value: string, options?: ActionOptions): Promise<ActionOutcome>;
  select(target: Target, value: string, options?: ActionOptions): Promise<ActionOutcome>;
  setChecked(target: Target, checked: boolean, options?: ActionOptions): Promise<ActionOutcome>;
  hover(target: Target, options?: ActionOptions): Promise<ActionOutcome>;
  scroll(options: { target?: Target; direction?: "up" | "down"; amount?: number }): Promise<ActionOutcome>;
  press(key: string, options?: ActionOptions): Promise<ActionOutcome>;
  wait(ms: number): Promise<void>;
  screenshot(path: string): Promise<string>;

  verify(expectation: Expectation, options?: ActionOptions): Promise<VerificationResult>;
  evaluateCondition(condition: Condition): Promise<boolean>;
  observe(maxChars?: number): Promise<PageObservation>;
  currentUrl(): string;
}
