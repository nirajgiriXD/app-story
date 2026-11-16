import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { DemoForgeError, fileExists } from "@demoforge/shared";
import { ProductConfigSchema, type AiProviderName, type ProductConfigInput, type TtsProviderName } from "@demoforge/contracts";

export interface InitProductOptions {
  id: string;
  name: string;
  baseUrl: string;
  description: string;
  aiProvider: AiProviderName;
  ttsProvider: TtsProviderName;
}

/** Create `products/<id>/` with a valid product.yaml and the standard folders. */
export async function scaffoldProduct(productsDir: string, options: InitProductOptions): Promise<string> {
  const dir = join(productsDir, options.id);
  if (await fileExists(join(dir, "product.yaml"))) {
    throw new DemoForgeError("CONFIG_INVALID", `Product '${options.id}' already exists at ${dir}.`);
  }
  const host = new URL(options.baseUrl).host;
  const config: ProductConfigInput = {
    version: 1,
    product: { id: options.id, name: options.name, description: options.description, base_url: options.baseUrl },
    browser: { viewport: { width: 1920, height: 1080 }, allowed_domains: [host], locale: "en-US", timezone: "UTC" },
    authentication: { strategy: "none" },
    demo: { default_language: "en", default_duration: 90, default_resolution: "1080p", template: "modern-saas" },
    branding: { primary_color: "#2563EB", accent_color: "#0F172A", font: "Inter" },
    providers: { ai: { provider: options.aiProvider }, tts: { provider: options.ttsProvider } },
    safety: { environment: "demo" },
  };
  ProductConfigSchema.parse(config); // never write a file we could not load back

  await mkdir(join(dir, "knowledge"), { recursive: true });
  await mkdir(join(dir, "scenarios"), { recursive: true });
  await mkdir(join(dir, "auth"), { recursive: true });
  await writeFile(join(dir, "product.yaml"), stringifyYaml(config), "utf8");
  await writeFile(
    join(dir, "instructions.md"),
    `# ${options.name} — demo instructions\n\nTell the AI agent anything it should know when demonstrating ${options.name}:\npreferred navigation, test data to use, things to avoid.\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "knowledge", "overview.md"),
    `# ${options.name}\n\n${options.description}\n\nDescribe the main areas of the product and key features here.\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "features.md"),
    [
      "<!--",
      "Paste your release notes below, in any format (changelog, bullet list, blog post).",
      `Then run: npx demoforge generate --product ${options.id} --features`,
      "The AI picks the features worth showing and skips bug fixes and internal changes.",
      "-->",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "auth", "README.md"),
    "Authentication state lives in `.secrets/` (git-ignored).\n\n" +
      "To save a logged-in session, run:\n\n    demoforge browser inspect --product " +
      options.id +
      " --save-auth\n\nthen set `authentication.strategy: storage_state` in product.yaml.\n",
    "utf8",
  );
  return dir;
}
