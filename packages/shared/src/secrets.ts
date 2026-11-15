import { DemoForgeError } from "./errors";

const registered = new Set<string>();
const MASK = "***";

/** Remember a secret value so it is scrubbed from logs, reports and AI prompts. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 4) registered.add(value);
}

export function redactSecrets<T>(value: T): T {
  if (registered.size === 0) return value;
  return scrub(value) as T;
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const secret of registered) out = out.split(secret).join(MASK);
    return out;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object" && !(value instanceof Error)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
    return out;
  }
  return value;
}

const ENV_TEMPLATE = /\{\{\s*env:([A-Z0-9_]+)\s*\}\}/g;

export function hasEnvTemplate(value: string): boolean {
  ENV_TEMPLATE.lastIndex = 0;
  return ENV_TEMPLATE.test(value);
}

/**
 * Resolve `{{env:NAME}}` placeholders. Resolved values are registered as secrets,
 * because the only reason to keep a value in the environment is that it is sensitive.
 */
export function resolveEnvTemplate(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_TEMPLATE, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === "") {
      throw new DemoForgeError("CONFIG_INVALID", `Environment variable ${name} is not set.`, {
        hint: `Add ${name}=... to your .env file.`,
      });
    }
    registerSecret(resolved);
    return resolved;
  });
}

export function requireEnv(name: string, hint?: string): string {
  const value = process.env[name];
  if (!value) {
    throw new DemoForgeError("CONFIG_INVALID", `Environment variable ${name} is not set.`, {
      hint: hint ?? `Add ${name}=... to your .env file (see .env.example).`,
    });
  }
  registerSecret(value);
  return value;
}
