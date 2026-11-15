import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve, extname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  ProductConfigSchema,
  formatZodError,
  type AiProviderName,
  type ProductConfig,
  type TtsProviderName,
} from "@demoforge/contracts";
import { DemoForgeError, fileExists } from "@demoforge/shared";
import { genericAdapter, type ProductAdapter } from "./adapter";

export interface KnowledgeDoc {
  file: string;
  content: string;
}

export interface LoadedProduct {
  id: string;
  dir: string;
  config: ProductConfig;
  instructions: string | undefined;
  knowledge: KnowledgeDoc[];
  scenarios: string[];
  adapter: ProductAdapter;
  adapterPath: string | undefined;
}

export interface ProviderOverrides {
  aiProvider?: AiProviderName;
  aiModel?: string;
  ttsProvider?: TtsProviderName;
}

export function resolveProductsDir(dir?: string): string {
  return resolve(dir ?? process.env.DEMOFORGE_PRODUCTS_DIR ?? "products");
}

export async function readProductConfig(file: string): Promise<ProductConfig> {
  let raw: unknown;
  try {
    raw = parseYaml(await readFile(file, "utf8"));
  } catch (error) {
    throw new DemoForgeError("CONFIG_INVALID", `Could not read ${file}: ${(error as Error).message}`, { cause: error });
  }
  const parsed = ProductConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DemoForgeError("CONFIG_INVALID", `Invalid product configuration in ${file}:\n${formatZodError(parsed.error)}`);
  }
  const config = parsed.data;
  if (config.browser.allowed_domains.length === 0) {
    config.browser.allowed_domains = [new URL(config.product.base_url).host];
  }
  return config;
}

/**
 * Precedence: CLI flags > environment variables > product.yaml.
 * A provider switch here is the user's explicit choice, not a silent fallback.
 */
export function applyOverrides(config: ProductConfig, overrides: ProviderOverrides = {}): ProductConfig {
  const env = process.env;
  const aiProvider = overrides.aiProvider ?? (env.DEMOFORGE_AI_PROVIDER as AiProviderName | undefined);
  const aiModel = overrides.aiModel ?? env.DEMOFORGE_AI_MODEL;
  const ttsProvider = overrides.ttsProvider ?? (env.DEMOFORGE_TTS_PROVIDER as TtsProviderName | undefined);
  const next = structuredClone(config);
  if (aiProvider && aiProvider !== next.providers.ai.provider) {
    if (!["anthropic", "openai"].includes(aiProvider)) {
      throw new DemoForgeError("CONFIG_INVALID", `Unknown AI provider '${aiProvider}'. Use anthropic or openai.`);
    }
    // The configured model belongs to the old provider, so drop it unless one was given.
    next.providers.ai = { ...next.providers.ai, provider: aiProvider, model: undefined, pricing: undefined };
  }
  if (aiModel) next.providers.ai.model = aiModel;
  if (ttsProvider && ttsProvider !== next.providers.tts.provider) {
    next.providers.tts = { ...next.providers.tts, provider: ttsProvider, voice: undefined, model: undefined };
  }
  return next;
}

async function readOptional(file: string): Promise<string | undefined> {
  return (await fileExists(file)) ? readFile(file, "utf8") : undefined;
}

async function listFiles(dir: string, extensions: string[]): Promise<string[]> {
  if (!(await fileExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && extensions.includes(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();
}

async function loadAdapter(dir: string): Promise<{ adapter: ProductAdapter; path: string | undefined }> {
  for (const name of ["adapter.ts", "adapter.mts", "adapter.mjs", "adapter.js"]) {
    const file = join(dir, name);
    if (await fileExists(file)) {
      const mod = (await import(pathToFileURL(file).href)) as { default?: ProductAdapter; adapter?: ProductAdapter };
      const adapter = mod.default ?? mod.adapter;
      if (!adapter || typeof adapter !== "object") {
        throw new DemoForgeError("CONFIG_INVALID", `${file} must export a default adapter object.`);
      }
      return { adapter, path: file };
    }
  }
  return { adapter: genericAdapter, path: undefined };
}

export async function loadProduct(productsDir: string, id: string, overrides?: ProviderOverrides): Promise<LoadedProduct> {
  const dir = join(productsDir, id);
  const file = join(dir, "product.yaml");
  if (!(await fileExists(file))) {
    throw new DemoForgeError("PRODUCT_NOT_FOUND", `Product '${id}' was not found (looked for ${file}).`, {
      hint: "Run `demoforge products list` to see configured products, or `demoforge init` to create one.",
    });
  }
  const config = applyOverrides(await readProductConfig(file), overrides);
  if (config.product.id !== id) {
    throw new DemoForgeError(
      "CONFIG_INVALID",
      `product.id '${config.product.id}' in ${file} must match its folder name '${id}'.`,
    );
  }
  const knowledgeDir = join(dir, "knowledge");
  const knowledge: KnowledgeDoc[] = [];
  for (const name of await listFiles(knowledgeDir, [".md", ".txt"])) {
    knowledge.push({ file: name, content: await readFile(join(knowledgeDir, name), "utf8") });
  }
  const scenarios = (await listFiles(join(dir, "scenarios"), [".yaml", ".yml"])).map((f) => basename(f, extname(f)));
  const { adapter, path: adapterPath } = await loadAdapter(dir);

  return {
    id,
    dir,
    config,
    instructions: await readOptional(join(dir, "instructions.md")),
    knowledge,
    scenarios,
    adapter,
    adapterPath,
  };
}

/** Resolve a path from product.yaml (logo, storage state, music) relative to the product folder. */
export function resolveProductPath(product: Pick<LoadedProduct, "dir">, path: string): string {
  return isAbsolute(path) ? path : resolve(product.dir, path);
}
