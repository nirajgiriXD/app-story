/**
 * Error codes map onto the job outcomes the design brief (docs/design.md) requires AppStory to distinguish
 * (application unavailable, authentication failure, unsupported workflow, ...).
 */
export type ErrorCode =
  | "CONFIG_INVALID"
  | "PRODUCT_NOT_FOUND"
  | "SCENARIO_NOT_FOUND"
  | "SCENARIO_NOT_APPROVED"
  | "APP_UNAVAILABLE"
  | "AUTH_FAILED"
  | "WORKFLOW_FAILED"
  | "VERIFICATION_FAILED"
  | "UNSUPPORTED_WORKFLOW"
  | "POLICY_VIOLATION"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_REFUSAL"
  | "PROVIDER_ERROR"
  | "PROVIDER_INVALID_OUTPUT"
  | "TTS_ERROR"
  | "TIMEOUT"
  | "RENDER_FAILED"
  | "DEPENDENCY_MISSING"
  | "INTERNAL";

export interface AppStoryErrorOptions {
  hint?: string;
  cause?: unknown;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class AppStoryError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: AppStoryErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppStoryError";
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function isAppStoryError(error: unknown): error is AppStoryError {
  return error instanceof AppStoryError;
}

export function toAppStoryError(error: unknown, fallback: ErrorCode = "INTERNAL"): AppStoryError {
  if (error instanceof AppStoryError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppStoryError(fallback, message, { cause: error });
}
