import type { ProductConfig, Step, Workflow } from "@app-story/contracts";
import { ActionGuard, isAllowedUrl, resolveUrl } from "@app-story/browser";
import { hasEnvTemplate } from "@app-story/shared";

export interface WorkflowValidation {
  errors: string[];
  warnings: string[];
}

/**
 * Static checks before anything runs. Runtime checks (the action guard, the domain
 * allow-list) still apply during execution; this catches problems early and cheaply.
 */
export function validateWorkflow(workflow: Workflow, config: ProductConfig): WorkflowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const guard = new ActionGuard(config.safety);
  const all: Step[] = [...workflow.setup, ...workflow.steps, ...workflow.cleanup];

  const seen = new Set<string>();
  for (const step of all) {
    if (seen.has(step.id)) errors.push(`Duplicate step id "${step.id}".`);
    seen.add(step.id);
  }

  for (const step of all) {
    if (step.action === "navigate" && step.url) {
      const url = resolveUrl(config.product.base_url, step.url);
      if (!isAllowedUrl(url, config.browser.allowed_domains)) {
        errors.push(`Step ${step.id} navigates to ${url}, which is outside browser.allowed_domains.`);
      }
    }
    if (step.target && ["click", "check", "uncheck", "select"].includes(step.action)) {
      const name = step.target.name ?? step.target.text ?? step.target.label ?? "";
      const decision = guard.check(step.action, { role: step.target.role ?? "button", name, tag: "" }, step.description);
      if (!decision.allowed) errors.push(`Step ${step.id}: ${decision.reason}`);
    }
    if (step.value && hasEnvTemplate(step.value) && !step.secret) {
      warnings.push(`Step ${step.id} uses an environment value; mark it \`secret: true\` so it is masked.`);
    }
    if (step.target?.css && !step.target.role && !step.target.label && !step.target.text) {
      warnings.push(`Step ${step.id} relies on a CSS selector only; accessible locators are more robust.`);
    }
  }

  const verifications = workflow.steps.filter((s) => s.action === "assert" || s.expected);
  if (verifications.length === 0) {
    errors.push("The workflow verifies nothing. Add at least one `assert` step or `expected` outcome.");
  }
  const last = workflow.steps[workflow.steps.length - 1];
  if (last && last.action !== "assert" && !last.expected) {
    warnings.push("The last step has no verification; the video may end before the outcome is confirmed.");
  }
  return { errors, warnings };
}
