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

/**
 * A login value from a product file: `env:NAME` reads the environment, anything else is
 * the value itself. Secrets (passwords) are registered so they never reach logs or prompts;
 * usernames are not, since masking a common word like "admin" everywhere would garble pages.
 */
export function resolveCredential(value: string, options: { secret: boolean; hint?: string }): string {
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
  const resolved = match ? (process.env[match[1] as string] ?? "") : value;
  if (!resolved) {
    throw new DemoForgeError("CONFIG_INVALID", `Environment variable ${match?.[1]} is not set.`, {
      hint: options.hint ?? `Add ${match?.[1]}=... to your .env file.`,
    });
  }
  if (options.secret) registerSecret(resolved);
  return resolved;
}

/** The `NAME` of an `env:NAME` reference, or undefined for a literal value. */
export function credentialEnvName(value: string): string | undefined {
  return /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim())?.[1];
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
