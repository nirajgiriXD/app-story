import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { resolveProductPath, type LoadedProduct } from "@demoforge/products";
import { credentialEnvName, fileExists, hasBinary } from "@demoforge/shared";

export interface ValidationItem {
  level: "ok" | "warning" | "error";
  message: string;
}

const API_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

/** Check a product file, keys, login, the app and local tools. Opens no browser. */
export async function validateProduct(product: LoadedProduct, options: { outputDir?: string } = {}): Promise<ValidationItem[]> {
  const items: ValidationItem[] = [];
  const ok = (message: string) => items.push({ level: "ok", message });
  const warn = (message: string) => items.push({ level: "warning", message });
  const error = (message: string) => items.push({ level: "error", message });
  const config = product.config;
  const startUrl = new URL(config.product.start_path, config.product.base_url).toString();

  ok(`${product.file} is valid (${config.product.name})`);
  if (!product.brief.trim()) warn("the file has nothing below its settings block; describe the app and add release notes");

  const reachable = await fetch(startUrl, { redirect: "manual", signal: AbortSignal.timeout(5_000) }).then(
    (res) => res.status < 500,
    () => false,
  );
  if (reachable) ok(`the app answers at ${startUrl}`);
  else warn(`the app does not answer at ${startUrl}; is it running?`);

  const ai = config.providers.ai;
  const aiKey = API_KEYS[ai.provider] as string;
  if (process.env[aiKey] || (ai.provider === "anthropic" && process.env.ANTHROPIC_AUTH_TOKEN)) ok(`AI: ${ai.provider}${ai.model ? ` / ${ai.model}` : ""} (${aiKey} found)`);
  else error(`${aiKey} is not set; add it to .env (or set "ai:" to the provider you have a key for)`);
  if (config.providers.ai_fallback) ok(`backup AI: ${config.providers.ai_fallback.provider}, used if ${ai.provider} fails`);

  const tts = config.providers.tts.provider;
  if (tts === "none") {
    ok("voice: off; videos get captions only");
  } else if (tts === "kokoro") {
    ok("voice: free local Kokoro voice, no key needed (first run downloads ~90 MB)");
    if (!config.demo.default_language.toLowerCase().startsWith("en")) {
      warn(`Kokoro voices speak English only, but language is '${config.demo.default_language}'`);
    }
  } else {
    const ttsKey = API_KEYS[tts] as string;
    if (process.env[ttsKey]) ok(`voice: ${tts} (${ttsKey} found)`);
    else error(`${ttsKey} is not set (needed for the ${tts} voice)`);
  }

  const auth = config.authentication;
  if (auth.strategy === "auto") {
    const missing = [auth.username, auth.password].map(credentialEnvName).filter((name) => name && !process.env[name]);
    for (const name of missing) error(`${name} is not set; add it to .env (it is used by "login:")`);
    if (missing.length === 0) {
      const passwordFrom = credentialEnvName(auth.password);
      ok(`login: ${credentialEnvName(auth.username) ? `from ${credentialEnvName(auth.username)}` : auth.username}, password ${passwordFrom ? `from ${passwordFrom}` : "written in the file"}`);
    }
  } else {
    ok("login: none");
  }

  const allowed = Object.entries(config.safety.allow).filter(([, on]) => on).map(([name]) => name.replace(/_/g, " "));
  ok(`blocked actions: ${allowed.length ? `all except ${allowed.join(", ")}` : "delete, payments, emails, publishing, account settings, invites"}`);

  for (const path of [config.branding.logo, config.branding.background_music]) {
    if (path && !(await fileExists(resolveProductPath(product, path)))) warn(`file not found: ${path}`);
  }

  if (options.outputDir) {
    const plans = await readdir(join(options.outputDir, ".plans", product.id)).catch(() => []);
    if (plans.length) ok(`${plans.length} saved plan(s) will be replayed without AI planning`);
  }

  if (await hasBinary("ffmpeg")) ok("ffmpeg found");
  else error("ffmpeg not found on PATH");
  if (await hasBinary("ffprobe")) ok("ffprobe found");
  else error("ffprobe not found on PATH");
  if (await fileExists(chromium.executablePath())) ok("Playwright Chromium installed");
  else error("Playwright Chromium is not installed; run `npm run browsers:install`");

  return items;
}
