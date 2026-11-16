import { chromium } from "playwright";
import { loadScenario, resolveProductPath, type LoadedProduct } from "@demoforge/products";
import { validateWorkflow } from "@demoforge/workflow";
import { getTemplate } from "@demoforge/video";
import { fileExists, hasBinary, isDemoForgeError } from "@demoforge/shared";

export interface ValidationItem {
  level: "ok" | "warning" | "error";
  message: string;
}

const API_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

/** Check configuration, scenarios, credentials and local tools without opening the app. */
export async function validateProduct(product: LoadedProduct): Promise<ValidationItem[]> {
  const items: ValidationItem[] = [];
  const ok = (message: string) => items.push({ level: "ok", message });
  const warn = (message: string) => items.push({ level: "warning", message });
  const error = (message: string) => items.push({ level: "error", message });
  const config = product.config;

  ok(`product.yaml is valid (${config.product.name}, ${config.product.base_url})`);
  ok(`allowed domains: ${config.browser.allowed_domains.join(", ")}`);
  if (product.adapterPath) ok(`custom adapter loaded from ${product.adapterPath}`);
  if (product.features) ok(`release notes found: ${product.features.file}`);

  try {
    getTemplate(config.demo.template);
    ok(`video template: ${config.demo.template}`);
  } catch (e) {
    error((e as Error).message);
  }

  const providers = [config.providers.ai, config.providers.ai_fallback].filter(Boolean);
  for (const ai of providers) {
    const env = API_KEYS[ai!.provider] as string;
    if (process.env[env]) ok(`${ai!.provider} credentials found (${env})`);
    else error(`${env} is not set (needed for the ${ai!.provider} AI provider)`);
  }
  const tts = config.providers.tts.provider;
  if (tts === "none") {
    ok("voice-over off (tts: none); videos get captions only");
  } else if (tts === "kokoro") {
    ok("voice-over: free local Kokoro voice, no key needed (first run downloads ~90 MB)");
    if (!config.demo.default_language.toLowerCase().startsWith("en")) {
      warn(`Kokoro voices speak English only, but demo.default_language is '${config.demo.default_language}'`);
    }
  } else {
    const ttsEnv = API_KEYS[tts] as string;
    if (process.env[ttsEnv]) ok(`${tts} text-to-speech credentials found (${ttsEnv})`);
    else error(`${ttsEnv} is not set (needed for ${tts} text-to-speech)`);
  }

  const auth = config.authentication;
  if (auth.strategy === "storage_state") {
    const path = resolveProductPath(product, auth.storage_state_path);
    if (await fileExists(path)) ok(`saved login state found at ${path}`);
    else error(`saved login state missing at ${path}; run \`demoforge browser inspect --product ${product.id} --save-auth\``);
  } else if (auth.strategy === "form") {
    for (const env of [auth.username_env, auth.password_env]) {
      if (process.env[env]) ok(`login variable ${env} is set`);
      else error(`login variable ${env} is not set; add it to products/${product.id}/.env`);
    }
  }

  for (const path of [config.branding.logo, config.branding.background_music]) {
    if (path && !(await fileExists(resolveProductPath(product, path)))) warn(`branding file not found: ${path}`);
  }

  for (const id of product.scenarios) {
    try {
      const workflow = await loadScenario(product, id);
      const result = validateWorkflow(workflow, config);
      result.errors.forEach((e) => error(`scenario ${id}: ${e}`));
      result.warnings.forEach((w) => warn(`scenario ${id}: ${w}`));
      if (!result.errors.length) ok(`scenario ${id}: valid${workflow.approved ? " (approved)" : " (not approved yet)"}`);
    } catch (e) {
      error(isDemoForgeError(e) ? e.message : String(e));
    }
  }

  if (await hasBinary("ffmpeg")) ok("ffmpeg found");
  else error("ffmpeg not found on PATH");
  if (await hasBinary("ffprobe")) ok("ffprobe found");
  else error("ffprobe not found on PATH");
  if (await fileExists(chromium.executablePath())) ok("Playwright Chromium installed");
  else error("Playwright Chromium is not installed; run `npm run browsers:install`");

  return items;
}
