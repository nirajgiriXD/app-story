import type { Box, BrowserIssue, Condition, CursorPoint, Expectation, Target } from "@app-story/contracts";

export interface PageObservation {
  url: string;
  title: string;
  /** Accessibility-tree snapshot (YAML-like). Untrusted page content. */
  snapshot: string;
  truncated: boolean;
  /** Elements on the page that the safety policy will refuse (see `offLimitsElements`). */
  offLimits?: { role: string; name: string; category: string }[];
}

export interface ActionOutcome {
  urlAfter: string;
  /** Element box in viewport CSS pixels, measured before the action. */
  box?: Box;
  /** The area around the element worth showing with it (its form, card, dialog or table). */
  region?: Box;
  elementName?: string;
}

export interface VerificationResult {
  ok: boolean;
  detail: string;
  /** Where the verified thing is on screen, when it is one element. */
  box?: Box;
  /** The area around it worth showing with it. */
  region?: Box;
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
  /** Address changes of the page, timed on the same clock as `now()`. */
  readonly navigations?: { t: number; url: string }[];
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
