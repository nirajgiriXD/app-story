export * from "./product";
export * from "./workflow";
export * from "./execution";
export * from "./narration";
export * from "./job";
export * from "./quality";
export * from "./release-notes";

import type { ZodError } from "zod";

/** Human-friendly one-issue-per-line rendering of a Zod error. */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}
