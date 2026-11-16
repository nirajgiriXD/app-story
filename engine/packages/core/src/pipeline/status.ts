import type { JobStatus } from "@demoforge/contracts";
import { toDemoForgeError, type ErrorCode } from "@demoforge/shared";

const STATUS_BY_CODE: Partial<Record<ErrorCode, JobStatus>> = {
  APP_UNAVAILABLE: "application_unavailable",
  AUTH_FAILED: "authentication_failure",
  UNSUPPORTED_WORKFLOW: "unsupported_workflow",
  POLICY_VIOLATION: "unsupported_workflow",
  SCENARIO_NOT_APPROVED: "unsupported_workflow",
  WORKFLOW_FAILED: "workflow_failure",
  VERIFICATION_FAILED: "workflow_failure",
  TIMEOUT: "workflow_failure",
  PROVIDER_RATE_LIMIT: "recoverable_failure",
};

/** Map an error to the job outcome the README asks DemoForge to distinguish. */
export function statusForError(error: unknown): JobStatus {
  const e = toDemoForgeError(error);
  const mapped = STATUS_BY_CODE[e.code];
  if (mapped) return mapped;
  if (e.retryable) return "recoverable_failure";
  return "failed";
}
