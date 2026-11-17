import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  AI_PROVIDERS,
  EffortSchema,
  KOKORO_VOICES,
  ProductConfigSchema,
  TEMPLATE_NAMES,
  TTS_PROVIDERS,
  VOICE_ACCENTS,
  VOICE_GENDERS,
  formatZodError,
  resolveKokoroVoice,
  type AiProviderName,
  type ProductConfig,
  type SafetyConfig,
  type TtsConfig,
  type TtsProviderName,
  type VoiceAccent,
} from "@app-story/contracts";
import { AppStoryError, fileExists, isAppStoryError } from "@app-story/shared";

/**
 * A product is one Markdown file, `products/<id>.md`:
 *
 *   ---
 *   url: https://staging.acme.com
 *   login: demo@acme.com / env:ACME_PASSWORD
 *   ---
 *   # Acme
 *   Plain English for the AI: what the app is, tips, release notes.
 *
 * The settings block is read by code and never sent to the AI. Everything else has a
 * sensible default, so most files only need `url` (and `login` if the app has one).
 */
export interface LoadedProduct {
  id: string;
  /** The product file. */
  file: string;
  /** The products folder; relative paths in the file (e.g. `logo`) start here. */
  dir: string;
  config: ProductConfig;
  /** Everything below the settings block, without `<!-- -->` notes: what the AI reads. */
  brief: string;
}

export interface ProviderOverrides {
  aiProvider?: AiProviderName;
  aiModel?: string;
  ttsProvider?: TtsProviderName;
}

const ALLOW_NAMES = {
  delete: "delete",
  payments: "payments",
  emails: "emails",
  publishing: "publishing",
  "account settings": "account_settings",
  "invite users": "invite_users",
  "production data": "production_data",
} as const satisfies Record<string, keyof SafetyConfig["allow"]>;

const SettingsSchema = z
  .object({
    url: z.url({ error: "url must be a full address, e.g. https://staging.my-app.com" }),
    login: z.string({ error: 'login must look like "user / password" (either part may be env:NAME)' }).optional(),
    "login page": z.string().optional(),
    "start page": z.string().optional(),
    ai: z.enum(AI_PROVIDERS).optional(),
    model: z.string().optional(),
    voice: z.enum(TTS_PROVIDERS).optional(),
    length: z.number({ error: "length is the video length in seconds, e.g. 60" }).int().min(10).max(600).optional(),
    language: z.string().optional(),
    template: z.enum(TEMPLATE_NAMES, { error: `template must be one of: ${TEMPLATE_NAMES.join(", ")}` }).optional(),
    fps: z.union([z.literal(30), z.literal(60)], { error: "fps is 30 or 60" }).optional(),
    resolution: z.enum(["1080p", "1440p", "4k"], { error: "resolution is 1080p, 1440p or 4k" }).optional(),
    logo: z.string().optional(),
    color: z
      .string({ error: 'put the color in quotes, e.g. color: "#4F46E5"' })
      .regex(/^#[0-9a-fA-F]{6}$/, 'use a 6-digit hex color in quotes, e.g. color: "#4F46E5"')
      .optional(),
    allow: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();
type Settings = z.infer<typeof SettingsSchema>;

/** Settings a product file may use, for help and error messages. */
export const PRODUCT_SETTINGS = Object.keys(SettingsSchema.shape);

const ID = /^[a-z0-9][a-z0-9-]*$/;

export function productFilePath(productsDir: string, id: string): string {
  return join(productsDir, `${id}.md`);
}

/** Split a product file into its settings block and the Markdown the AI reads. */
export function splitProductFile(text: string, file: string): { settings: unknown; brief: string } {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) {
    throw new AppStoryError("CONFIG_INVALID", `${file} has no settings block at the top.`, {
      hint: "Start the file with:\n---\nurl: https://your-app.example.com\n---",
    });
  }
  let settings: unknown;
  try {
    settings = parseYaml(match[1] as string) ?? {};
  } catch (error) {
    throw new AppStoryError("CONFIG_INVALID", `The settings block in ${file} could not be read: ${(error as Error).message}`);
  }
  const brief = normalized
    .slice(match[0].length)
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    .trim();
  return { settings, brief };
}

function parseLogin(login: string, file: string): { username: string; password: string } {
  const at = login.indexOf(" / ");
  const username = login.slice(0, at).trim();
  const password = login.slice(at + 3).trim();
  if (at < 0 || !username || !password) {
    throw new AppStoryError("CONFIG_INVALID", `login in ${file} must look like "user / password".`, {
      hint: "For example: login: demo@acme.com / env:ACME_PASSWORD  (the password then comes from .env)",
    });
  }
  return { username, password };
}

function parseAllow(allow: Settings["allow"], file: string): Partial<SafetyConfig["allow"]> {
  const items = (Array.isArray(allow) ? allow : (allow ?? "").split(",")).map((s) => s.trim().toLowerCase().replace(/[_-]+/g, " ")).filter(Boolean);
  const out: Partial<SafetyConfig["allow"]> = {};
  for (const item of items) {
    const key = ALLOW_NAMES[item as keyof typeof ALLOW_NAMES];
    if (!key) {
      throw new AppStoryError("CONFIG_INVALID", `Unknown entry '${item}' in allow: in ${file}.`, {
        hint: `Use any of: ${Object.keys(ALLOW_NAMES).join(", ")}.`,
      });
    }
    out[key] = true;
  }
  return out;
}

/** The first `# Heading`, and the first plain paragraph under it. */
function describe(brief: string, id: string): { name: string; description: string } {
  const lines = brief.split("\n");
  const titleAt = lines.findIndex((l) => /^#\s+\S/.test(l));
  const name = titleAt >= 0 ? (lines[titleAt] as string).replace(/^#\s+/, "").trim() : id;
  const paragraph: string[] = [];
  for (const line of lines.slice(titleAt + 1)) {
    const text = line.trim();
    if (!text) {
      if (paragraph.length) break;
      continue;
    }
    if (/^(#|[-*+]\s|\d+\.\s|>|```)/.test(text)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(text);
  }
  return { name, description: paragraph.join(" ") || `${name} web application` };
}

function hasKey(provider: AiProviderName): boolean {
  const env = process.env;
  return provider === "anthropic" ? Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) : Boolean(env.OPENAI_API_KEY);
}

/** Turn a product file's text into the engine's full configuration. */
export function parseProductFile(text: string, file: string, id: string): { config: ProductConfig; brief: string } {
  const { settings: raw, brief } = splitProductFile(text, file);
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppStoryError("CONFIG_INVALID", `Invalid settings in ${file}:\n${formatZodError(parsed.error)}`, {
      hint: `Allowed settings: ${PRODUCT_SETTINGS.join(", ")}. See "Product files" in README.md.`,
    });
  }
  const s = parsed.data;
  const url = new URL(s.url);
  const login = s.login ? parseLogin(s.login, file) : undefined;
  const { name, description } = describe(brief, id);

  // Default AI: the one with a key. The other one, if it also has a key, is the fallback.
  const ai: AiProviderName = s.ai ?? (hasKey("anthropic") ? "anthropic" : hasKey("openai") ? "openai" : "anthropic");
  const other: AiProviderName = ai === "anthropic" ? "openai" : "anthropic";

  const config = ProductConfigSchema.safeParse({
    version: 1,
    product: { id, name, description, base_url: url.origin, start_path: s["start page"] ?? `${url.pathname}${url.search}` },
    // A 16:9 viewport with comfortably large UI, recorded at 2x (3200x1800): the video zooms
    // in up to ~1.9x on screen, and at 1080p that needs about two pixels per CSS pixel to stay sharp.
    browser: { viewport: { width: 1600, height: 900 }, device_scale_factor: 2, allowed_domains: [url.host] },
    authentication: login ? { strategy: "auto", ...login, login_path: s["login page"] } : { strategy: "none" },
    demo: { default_language: s.language, default_duration: s.length, template: s.template, fps: s.fps, default_resolution: s.resolution },
    branding: { logo: s.logo, primary_color: s.color },
    providers: {
      ai: { provider: ai, model: s.model },
      ai_fallback: hasKey(other) ? { provider: other } : undefined,
      tts: { provider: s.voice },
    },
    safety: { allow: parseAllow(s.allow, file) },
  });
  if (!config.success) {
    throw new AppStoryError("CONFIG_INVALID", `Invalid settings in ${file}:\n${formatZodError(config.error)}`);
  }
  return { config: config.data, brief };
}

/**
 * Environment overrides (APP_STORY_AI_PROVIDER, APP_STORY_AI_MODEL, APP_STORY_AI_EFFORT,
 * APP_STORY_TTS_PROVIDER) and explicit ones from code win over the product file.
 */
export function applyOverrides(config: ProductConfig, overrides: ProviderOverrides = {}): ProductConfig {
  const env = process.env;
  const aiProvider = overrides.aiProvider ?? (env.APP_STORY_AI_PROVIDER as AiProviderName | undefined);
  const aiModel = overrides.aiModel ?? env.APP_STORY_AI_MODEL;
  const ttsProvider = overrides.ttsProvider ?? (env.APP_STORY_TTS_PROVIDER as TtsProviderName | undefined);
  const next = structuredClone(config);
  if (aiProvider && aiProvider !== next.providers.ai.provider) {
    if (!(AI_PROVIDERS as readonly string[]).includes(aiProvider)) {
      throw new AppStoryError("CONFIG_INVALID", `Unknown AI provider '${aiProvider}'. Use anthropic or openai.`);
    }
    // The configured model belongs to the old provider, so drop it unless one was given.
    next.providers.ai = { ...next.providers.ai, provider: aiProvider, model: undefined, pricing: undefined };
    if (next.providers.ai_fallback?.provider === aiProvider) next.providers.ai_fallback = undefined;
  }
  if (aiModel) next.providers.ai.model = aiModel;
  const effort = env.APP_STORY_AI_EFFORT?.trim().toLowerCase();
  if (effort) {
    const parsed = EffortSchema.safeParse(effort);
    if (!parsed.success) {
      throw new AppStoryError("CONFIG_INVALID", `APP_STORY_AI_EFFORT must be one of ${EffortSchema.options.join(", ")}, not '${effort}'.`);
    }
    // Applies to every AI phase, on the fallback provider too.
    next.providers.ai.effort = parsed.data;
    if (next.providers.ai_fallback) next.providers.ai_fallback.effort = parsed.data;
  }
  if (ttsProvider && ttsProvider !== next.providers.tts.provider) {
    if (!(TTS_PROVIDERS as readonly string[]).includes(ttsProvider)) {
      throw new AppStoryError("CONFIG_INVALID", `Unknown voice '${ttsProvider}'. Use ${TTS_PROVIDERS.join(", ")}.`);
    }
    next.providers.tts = { ...next.providers.tts, provider: ttsProvider, voice: undefined, model: undefined };
  }
  next.providers.tts = applyVoiceSettings(next.providers.tts);
  return next;
}

/**
 * Voice choices from .env, for every product: APP_STORY_VOICE (female, male or a voice
 * name), APP_STORY_VOICE_ACCENT, APP_STORY_VOICE_SPEED and APP_STORY_VOICE_TONE.
 * Checked here, so a typo fails before any AI work instead of at the narration step.
 */
export function applyVoiceSettings(tts: TtsConfig, env: NodeJS.ProcessEnv = process.env): TtsConfig {
  const read = (name: string) => env[name]?.trim() || undefined;
  const next = { ...tts };
  const voice = read("APP_STORY_VOICE");
  const accent = read("APP_STORY_VOICE_ACCENT")?.toLowerCase();
  const speed = read("APP_STORY_VOICE_SPEED");
  const tone = read("APP_STORY_VOICE_TONE");

  if (voice) next.voice = voice;
  if (accent) {
    if (!(VOICE_ACCENTS as readonly string[]).includes(accent)) {
      throw new AppStoryError("CONFIG_INVALID", `APP_STORY_VOICE_ACCENT must be ${VOICE_ACCENTS.join(" or ")}, not '${accent}'.`);
    }
    next.accent = accent as VoiceAccent;
  }
  if (speed) {
    const value = Number(speed);
    if (!(value >= 0.7 && value <= 1.3)) {
      throw new AppStoryError("CONFIG_INVALID", `APP_STORY_VOICE_SPEED must be a number from 0.7 (slower) to 1.3 (faster), not '${speed}'.`);
    }
    next.speed = value;
  }
  if (tone) next.style = tone;

  if (next.provider === "kokoro" && !resolveKokoroVoice(next.voice, next.accent)) {
    const names = (gender: string) =>
      KOKORO_VOICES.filter((v) => v.gender === gender)
        .map((v) => v.id)
        .join(", ");
    throw new AppStoryError("CONFIG_INVALID", `Unknown voice '${next.voice}' in APP_STORY_VOICE.`, {
      hint: `Use female, male, or one of the Kokoro voices.\n  female: ${names("female")}\n  male:   ${names("male")}`,
    });
  }
  const byGender = next.voice && (VOICE_GENDERS as readonly string[]).includes(next.voice.toLowerCase());
  if (byGender && (next.provider === "openai" || next.provider === "elevenlabs")) {
    throw new AppStoryError("CONFIG_INVALID", `APP_STORY_VOICE=${next.voice} picks a voice by gender, which only the free Kokoro voice can do.`, {
      hint: next.provider === "openai" ? "Name an OpenAI voice instead, e.g. marin, cedar, coral or onyx." : "Use a voice id from your ElevenLabs account.",
    });
  }
  return next;
}

export async function loadProduct(productsDir: string, id: string, overrides?: ProviderOverrides): Promise<LoadedProduct> {
  const file = productFilePath(productsDir, id);
  if (!ID.test(id) || !(await fileExists(file))) {
    throw new AppStoryError("PRODUCT_NOT_FOUND", `Product '${id}' was not found (looked for ${file}).`, {
      hint: "Run `npx app-story list` to see your products, or `npx app-story new <name>` to create one.",
    });
  }
  const { config, brief } = parseProductFile(await readFile(file, "utf8"), file, id);
  return { id, file, dir: productsDir, config: applyOverrides(config, overrides), brief };
}

export interface ProductListing {
  id: string;
  name?: string;
  base_url?: string;
  valid: boolean;
  error?: string;
}

/** Every `products/<id>.md`, except a README.md and files starting with `_` or `.`. */
export async function listProducts(productsDir: string): Promise<ProductListing[]> {
  if (!(await fileExists(productsDir))) return [];
  const entries = await readdir(productsDir, { withFileTypes: true });
  const listings: ProductListing[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || /^[_.]/.test(entry.name) || entry.name.toLowerCase() === "readme.md") continue;
    const id = entry.name.slice(0, -3);
    if (!ID.test(id)) {
      listings.push({ id, valid: false, error: "file name must be lowercase letters, numbers and dashes, e.g. my-app.md" });
      continue;
    }
    try {
      const { config } = await loadProduct(productsDir, id);
      listings.push({ id, name: config.product.name, base_url: `${config.product.base_url}${config.product.start_path}`, valid: true });
    } catch (error) {
      listings.push({ id, valid: false, error: isAppStoryError(error) ? error.message : String(error) });
    }
  }
  return listings.sort((a, b) => a.id.localeCompare(b.id));
}

/** Create `products/<id>.md` from a short template. Never overwrites a file. */
export async function newProductFile(productsDir: string, options: { id: string; url: string; name?: string }): Promise<string> {
  if (!ID.test(options.id)) {
    throw new AppStoryError("CONFIG_INVALID", `'${options.id}' is not a valid product name.`, {
      hint: "Use lowercase letters, numbers and dashes, e.g. my-app.",
    });
  }
  const file = productFilePath(productsDir, options.id);
  if (await fileExists(file)) throw new AppStoryError("CONFIG_INVALID", `${file} already exists.`);
  const name = options.name ?? options.id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const text = [
    "---",
    `url: ${options.url}`,
    `# login: demo@example.com / env:${options.id.toUpperCase().replace(/-/g, "_")}_PASSWORD`,
    "---",
    "",
    `# ${name}`,
    "",
    "<!-- One or two sentences: what the app is and who uses it. -->",
    "",
    "## Tips for the demo",
    "",
    "<!-- Where things are, what test data to use, what to avoid. -->",
    "",
    "## Release notes",
    "",
    "<!-- Paste your release notes here, in any format. -->",
    "",
  ].join("\n");
  parseProductFile(text, file, options.id); // never write a file we could not load back
  await writeFile(file, text, "utf8");
  return file;
}

/** Resolve a path from the product file (e.g. logo) relative to the products folder. */
export function resolveProductPath(product: Pick<LoadedProduct, "dir">, path: string): string {
  return isAbsolute(path) ? path : resolve(product.dir, path);
}
