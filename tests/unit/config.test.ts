import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProductConfigSchema, TEMPLATE_NAMES, WorkflowSchema, pickTemplate } from "@app-story/contracts";
import { chatterboxLanguage } from "@app-story/narration";
import { getTemplate } from "@app-story/video";
import { applyOverrides, listProducts, loadProduct, newProductFile, parseProductFile } from "@app-story/products";
import { describeIssues, unexpectedIssues } from "@app-story/core";
import { makeVideos } from "../../cli/src/commands/make";
import { buildProgram } from "../../cli/src/program";
import { terminalReviewer } from "../../cli/src/review";
import { type AppStoryError, aiKeySource, anthropicGatewayOptions, openaiGatewayOptions, redactSecrets, resolveCredential } from "@app-story/shared";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CUSTOM_AI_API_KEY",
  "CUSTOM_AI_BASE_URL",
  "APP_STORY_AI_PROVIDER",
  "APP_STORY_AI_MODEL",
  "APP_STORY_TTS_PROVIDER",
  "APP_STORY_VOICE",
  "APP_STORY_VOICE_ACCENT",
  "APP_STORY_VOICE_SPEED",
  "APP_STORY_VOICE_TONE",
];
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const file = (settings: string, body = "# Acme\n\nAcme is a billing tool for small shops.\n") => `---\n${settings}\n---\n\n${body}`;
const parse = (text: string) => parseProductFile(text, "acme.md", "acme");
const errorOf = (fn: () => unknown): AppStoryError => {
  try {
    fn();
  } catch (error) {
    return error as AppStoryError;
  }
  throw new Error("expected an error");
};

describe("product file", () => {
  it("needs only a url; everything else has a sensible default", () => {
    const { config, brief } = parse(file("url: https://staging.acme.test/app?tab=1"));
    expect(config.product).toMatchObject({
      id: "acme",
      name: "Acme",
      description: "Acme is a billing tool for small shops.",
      base_url: "https://staging.acme.test",
      start_path: "/app?tab=1",
    });
    expect(config.browser).toMatchObject({ viewport: { width: 1600, height: 900 }, device_scale_factor: 2, allowed_domains: ["staging.acme.test"] });
    expect(config.authentication).toEqual({ strategy: "none" });
    expect(config.providers.tts.provider).toBe("kokoro");
    expect(config.demo.default_duration).toBe(90);
    expect(config.safety.allow).toMatchObject({ delete: false, payments: false, emails: false });
    expect(brief).toBe("# Acme\n\nAcme is a billing tool for small shops.");
  });

  it("keeps the settings block and <!-- notes --> away from the AI", () => {
    const { brief } = parse(file("url: https://acme.test\nlogin: me@acme.test / hunter22", "# Acme\n<!-- private note -->\nRelease notes here.\n"));
    expect(brief).toBe("# Acme\nRelease notes here.");
    expect(brief).not.toContain("hunter22");
  });

  it("reads the login, written directly or as env:NAME", () => {
    const direct = parse(file("url: https://acme.test\nlogin: me@acme.test / p@ss / word\nlogin page: /signin")).config.authentication;
    expect(direct).toEqual({ strategy: "auto", username: "me@acme.test", password: "p@ss / word", login_path: "/signin" });
    const fromEnv = parse(file("url: https://acme.test\nlogin: env:ACME_USER / env:ACME_PASSWORD")).config.authentication;
    expect(fromEnv).toMatchObject({ username: "env:ACME_USER", password: "env:ACME_PASSWORD" });
  });

  it("maps the optional settings", () => {
    const { config } = parse(
      file(
        'url: https://acme.test\nai: openai\nmodel: gpt-5\nvoice: none\nlength: 45\nlanguage: de\nlogo: acme.png\ncolor: "#112233"\nallow: delete, invite users',
      ),
    );
    expect(config.providers.ai).toMatchObject({ provider: "openai", model: "gpt-5" });
    expect(config.providers.tts.provider).toBe("none");
    expect(config.demo).toMatchObject({ default_duration: 45, default_language: "de" });
    expect(config.branding).toMatchObject({ logo: "acme.png", primary_color: "#112233" });
    expect(config.safety.allow).toMatchObject({ delete: true, invite_users: true, payments: false });
  });

  it("reads the public website and the end card's call to action", () => {
    const { config } = parse(file('url: https://staging.acme.test/app\nwebsite: https://acme.com\ncta: "Start free at {host}"'));
    expect(config.product).toMatchObject({ base_url: "https://staging.acme.test", website: "https://acme.com" });
    expect(config.branding.cta).toBe("Start free at {host}");
    expect(errorOf(() => parse(file("url: https://acme.test\nwebsite: acme.com"))).message).toMatch(/website must be a full address/);
  });

  it("reads font as a font file next to the product file, or as a font name", () => {
    const fontOf = (settings: string) => {
      const { font, font_file } = parse(file(`url: https://acme.test${settings}`)).config.branding;
      return { font, font_file };
    };
    expect(fontOf("")).toEqual({ font: "Inter", font_file: undefined });
    expect(fontOf("\nfont: brand/Acme-Sans.woff2")).toEqual({ font: "Inter", font_file: "brand/Acme-Sans.woff2" });
    expect(fontOf("\nfont: Roboto")).toEqual({ font: "Roboto", font_file: undefined });
  });

  it("turns on background music from the file", () => {
    expect(parse(file("url: https://acme.test")).config.branding.background_music).toBeUndefined();
    const { config } = parse(file("url: https://acme.test\nmusic: calm.mp3\nmusic volume: 0.12"));
    expect(config.branding).toMatchObject({ background_music: "calm.mp3", music_volume: 0.12 });
    expect(errorOf(() => parse(file("url: https://acme.test\nmusic volume: 3"))).message).toMatch(/music volume/);
  });

  it("reads more languages and extra formats, and refuses an English-only voice for other languages", () => {
    const { config } = parse(file("url: https://acme.test\nvoice: openai\nlanguage: en, de, fr\nformats: vertical, gif"));
    expect(config.demo).toMatchObject({ default_language: "en", languages: ["de", "fr"], formats: ["vertical", "gif"] });
    expect(parse(file("url: https://acme.test\nlanguage: de")).config.demo).toMatchObject({ default_language: "de", languages: [] });
    expect(errorOf(() => applyOverrides(parse(file("url: https://acme.test\nlanguage: en, de")).config)).message).toMatch(/kokoro voice speaks English only/);
    expect(errorOf(() => applyOverrides(parse(file("url: https://acme.test\nlanguage: de")).config)).hint).toMatch(/voice: chatterbox/);
    // Chatterbox speaks 23 languages, but not every one.
    expect(applyOverrides(parse(file("url: https://acme.test\nvoice: chatterbox\nlanguage: en, de, pt-BR")).config).demo.languages).toEqual(["de", "pt-BR"]);
    expect(errorOf(() => applyOverrides(parse(file("url: https://acme.test\nvoice: chatterbox\nlanguage: en, uk")).config)).message).toMatch(
      /cannot narrate uk/,
    );
    expect([chatterboxLanguage("en-GB"), chatterboxLanguage("pt-BR"), chatterboxLanguage("de")]).toEqual([undefined, "pt", "de"]);
    expect(errorOf(() => parse(file("url: https://acme.test\nformats: vertical, tiktok"))).message).toMatch(/Unknown entry 'tiktok' in formats/);
  });

  it("reads blur as one CSS selector list or as a YAML list", () => {
    expect(parse(file("url: https://acme.test")).config.browser.blur).toEqual([]);
    expect(parse(file('url: https://acme.test\nblur: ".api-key, #email"')).config.browser.blur).toEqual([".api-key, #email"]);
    // Unquoted, YAML would read "#email" as a comment and leave the email readable.
    expect(errorOf(() => parse(file("url: https://acme.test\nblur: .api-key, #email"))).hint).toContain('blur: ".api-key, #email"');

    expect(parse(file('url: https://acme.test\nblur:\n  - .api-key\n  - "[data-private]"')).config.browser.blur).toEqual([".api-key", "[data-private]"]);
  });

  it("uses the template set in the file, or picks one that suits the kind of video", () => {
    const set = parse(file("url: https://acme.test\ntemplate: minimal")).config.demo.template;
    expect(set).toBe("minimal");
    expect(pickTemplate(set, "whats-new")).toBe("minimal"); // the file's choice always wins

    const unset = parse(file("url: https://acme.test")).config.demo.template;
    expect(unset).toBeUndefined();
    expect(pickTemplate(unset, "whats-new")).toBe("product-update");
    expect(pickTemplate(unset, "feature")).toBe("feature-highlight");
    expect(pickTemplate(unset, "how-to")).toBe("tutorial");
    expect(pickTemplate(unset, undefined)).toBe("modern-saas");
    // Every name the product file accepts is a template the renderer has.
    for (const name of TEMPLATE_NAMES) expect(getTemplate(name).name).toBe(name);

    expect(errorOf(() => parse(file("url: https://acme.test\ntemplate: fancy"))).message).toMatch(/template must be one of: modern-saas/);
  });

  it("explains every mistake clearly", () => {
    expect(errorOf(() => parse("# Acme\nno settings")).message).toMatch(/no settings block/);
    const invalid = errorOf(() => parse(file("url: not a url\ncolour: red")));
    expect(invalid.message).toContain("url");
    expect(invalid.message).toContain("colour");
    expect(invalid.hint).toContain("Allowed settings");
    expect(errorOf(() => parse(file("url: https://acme.test\ncolor: #112233"))).message).toMatch(/quotes/);
    expect(errorOf(() => parse(file("url: https://acme.test\nlogin: just-a-user"))).message).toMatch(/user \/ password/);
    expect(errorOf(() => parse(file("url: https://acme.test\nallow: everything"))).message).toMatch(/Unknown entry 'everything'/);
  });

  it("picks the AI you have a key for, and the other one as backup", () => {
    expect(parse(file("url: https://acme.test")).config.providers).toMatchObject({ ai: { provider: "anthropic" }, ai_fallback: undefined });
    process.env.OPENAI_API_KEY = "sk-test";
    expect(parse(file("url: https://acme.test")).config.providers).toMatchObject({ ai: { provider: "openai" }, ai_fallback: undefined });
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(parse(file("url: https://acme.test")).config.providers).toMatchObject({ ai: { provider: "anthropic" }, ai_fallback: { provider: "openai" } });
  });

  it("reaches both AIs through a custom gateway when neither has its own key", () => {
    // The key alone does nothing: a generic CUSTOM_AI_API_KEY may belong to another tool.
    process.env.CUSTOM_AI_API_KEY = "sk-gateway-test";
    expect(aiKeySource("anthropic")).toBeUndefined();
    process.env.CUSTOM_AI_BASE_URL = "https://gateway.test/v1/";
    // No backup through the gateway: it serves only the models given to its key.
    expect(parse(file("url: https://acme.test")).config.providers).toMatchObject({ ai: { provider: "anthropic" }, ai_fallback: undefined });
    expect(aiKeySource("anthropic")).toBe("CUSTOM_AI_API_KEY");
    expect(anthropicGatewayOptions()).toEqual({ apiKey: null, authToken: "sk-gateway-test", baseURL: "https://gateway.test" });
    expect(openaiGatewayOptions()).toEqual({ apiKey: "sk-gateway-test", baseURL: "https://gateway.test/v1" });
    // A provider's own key wins, and that provider then talks to its own API.
    process.env.OPENAI_API_KEY = "sk-test";
    expect(aiKeySource("openai")).toBe("OPENAI_API_KEY");
    expect(openaiGatewayOptions()).toEqual({});
    expect(anthropicGatewayOptions().baseURL).toBe("https://gateway.test");
  });

  it("lets .env overrides switch the AI, dropping the old model and a backup that is now the main one", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";
    const { config } = parse(file("url: https://acme.test\nmodel: claude-opus-5-5"));
    const switched = applyOverrides(config, { aiProvider: "openai" });
    expect(switched.providers.ai).toMatchObject({ provider: "openai", model: undefined });
    expect(switched.providers.ai_fallback).toBeUndefined();
    expect(config.providers.ai.model).toBe("claude-opus-5-5"); // original untouched
  });
});

describe("browser errors", () => {
  const issues = [
    { kind: "console_error", message: "Failed to load resource: the server responded with a status of 401 ()", url: "https://toolshop.test/" },
    { kind: "console_error", message: "Failed to load resource: the server responded with a status of 401 ()", url: "https://toolshop.test/" },
    { kind: "console_error", message: "ERROR {message: Unauthorized}", url: "https://toolshop.test/" },
    { kind: "blocked_navigation", message: "Navigation outside allowed domains was blocked.", url: "https://ads.test/" },
  ];

  it("are named in the warning, each once with how often it came", () => {
    const text = describeIssues(unexpectedIssues(issues, []));
    expect(text).toMatch(/^3 console\/network issue\(s\): "Failed to load resource: .*401 \(\)" ×2, "ERROR \{message: Unauthorized\}"/);
    expect(text).toContain("ignore errors:");
    expect(text).not.toContain("browser.json"); // a scratch file, gone once the video succeeds
  });

  it("expected ones can be ignored with ignore errors:, by any word they contain", () => {
    const { config } = parse(file("url: https://acme.test\nignore errors: 401, unauthorized"));
    expect(config.browser.ignore_errors).toEqual(["401", "unauthorized"]);
    expect(unexpectedIssues(issues, config.browser.ignore_errors)).toEqual([]);
    expect(parse(file("url: https://acme.test\nignore errors: 401")).config.browser.ignore_errors).toEqual(["401"]); // a YAML number
    expect(parse(file("url: https://acme.test")).config.browser.ignore_errors).toEqual([]);
  });
});

describe("## Videos in a product file", () => {
  const body = [
    "# Toolshop",
    "",
    "An online hardware store.",
    "",
    "## Videos",
    "- Search for pliers, filter by brand,",
    "  sort by price and add one to the cart",
    "* Compare hand tools and power tools",
    "1. Switch the language to German",
    "Plain text here is not a video.",
    "",
    "### Tips for these videos",
    "- A sub-heading still belongs to the section",
    "",
    "## Release notes",
    "- Dark mode.",
  ].join("\n");

  it("lists one goal per item, joins indented lines, and keeps the section from the AI", () => {
    const { videos, brief, config } = parse(file("url: https://acme.test", body));
    expect(videos).toEqual([
      "Search for pliers, filter by brand, sort by price and add one to the cart",
      "Compare hand tools and power tools",
      "Switch the language to German",
      "A sub-heading still belongs to the section",
    ]);
    expect(brief).toBe("# Toolshop\n\nAn online hardware store.\n\n## Release notes\n- Dark mode.");
    expect(config.product.description).toBe("An online hardware store.");
  });

  it("is empty without the section, and the brief is untouched", () => {
    const plain = file("url: https://acme.test", "# Acme\n\n## Release notes\n- Videos of invoices.\n");
    expect(parse(plain)).toMatchObject({ videos: [], brief: "# Acme\n\n## Release notes\n- Videos of invoices." });
  });

  it("--review needs a terminal to ask in", () => {
    // Tests run without one, like CI.
    expect(() => terminalReviewer()).toThrow(/--review asks in the terminal/);
  });

  it("cannot be mixed with a goal or --each", async () => {
    const program = buildProgram();
    await expect(makeVideos("acme", ["show", "export"], { videos: true }, program)).rejects.toThrow(/cannot be used with a goal/);
    await expect(makeVideos("acme", [], { videos: true, each: true }, program)).rejects.toThrow(/cannot be used with --each/);
  });
});

describe("products folder", () => {
  it("lists product files, skipping README.md and _drafts, and flags bad names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "df-"));
    await writeFile(join(dir, "acme.md"), file("url: https://acme.test"));
    await writeFile(join(dir, "broken.md"), "no settings");
    await writeFile(join(dir, "README.md"), "# Products");
    await writeFile(join(dir, "_draft.md"), file("url: https://draft.test"));
    await writeFile(join(dir, "My App.md"), file("url: https://x.test"));
    const listed = await listProducts(dir);
    expect(listed.map((p) => [p.id, p.valid])).toEqual([
      ["acme", true],
      ["broken", false],
      ["My App", false],
    ]);
  });

  it("creates a new product file that loads back, and never overwrites one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "df-"));
    const path = await newProductFile(dir, { id: "shop-front", url: "https://shop.test" });
    const product = await loadProduct(dir, "shop-front");
    expect(product.file).toBe(path);
    expect(product.config.product).toMatchObject({ name: "Shop Front", base_url: "https://shop.test" });
    expect(product.config.authentication.strategy).toBe("none"); // the login line starts commented out
    expect(product.brief).not.toContain("<!--");
    await expect(newProductFile(dir, { id: "shop-front", url: "https://x.test" })).rejects.toThrow(/already exists/);
    await expect(newProductFile(dir, { id: "Bad Name", url: "https://x.test" })).rejects.toThrow(/not a valid product name/);
  });

  it("loads the bundled example product", async () => {
    const product = await loadProduct("apps", "example");
    expect(product.config.authentication).toMatchObject({ strategy: "auto", username: "demo@example.com" });
    expect(product.config.product.start_path).toBe("/projects");
    expect(product.brief).toContain("## Release notes");
  });

  it("keeps the product file examples in README.md and docs/design.md valid", async () => {
    const docs = (await readFile("README.md", "utf8")) + (await readFile("docs/design.md", "utf8"));
    const examples = [...docs.matchAll(/```markdown\r?\n(---[\s\S]*?)```/g)].map((m) => m[1] as string);
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const example of examples) expect(() => parse(example)).not.toThrow();
  });
});

describe("credentials", () => {
  it("reads env:NAME, hides passwords from logs, and leaves usernames readable", () => {
    process.env.DF_TEST_SECRET = "s3cret-value";
    try {
      expect(resolveCredential("env:DF_TEST_SECRET", { secret: true })).toBe("s3cret-value");
      expect(resolveCredential("admin-user", { secret: false })).toBe("admin-user");
      expect(redactSecrets("log s3cret-value as admin-user")).toBe("log *** as admin-user");
      expect(() => resolveCredential("env:DF_TEST_MISSING", { secret: true })).toThrow(/DF_TEST_MISSING is not set/);
    } finally {
      delete process.env.DF_TEST_SECRET;
    }
  });
});

describe("engine configuration", () => {
  it("fills safe defaults", () => {
    const config = ProductConfigSchema.parse({
      version: 1,
      product: { id: "acme", name: "Acme", description: "Test app", base_url: "https://demo.acme.test" },
      providers: { ai: { provider: "anthropic" } },
    });
    expect(config.safety.allow.delete).toBe(false);
    expect(config.safety.allow.payments).toBe(false);
    expect(config.recording.engine).toBe("cdp");
    expect(config.demo.default_resolution).toBe("1080p");
    expect(config.providers.ai.max_iterations).toBe(30);
  });
});

describe("workflow contract", () => {
  const base = { workflow_version: 1, id: "w", title: "T", objective: "O" };

  it("rejects actions without the data they need", () => {
    const result = WorkflowSchema.safeParse({
      ...base,
      steps: [
        { id: "a", description: "x", action: "click" },
        { id: "b", description: "x", action: "assert" },
        { id: "c", description: "x", action: "fill", target: { label: "Name" } },
      ],
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["steps.0.target", "steps.1.expected", "steps.2.value"]));
  });

  it("rejects an empty target", () => {
    const result = WorkflowSchema.safeParse({ ...base, steps: [{ id: "a", description: "x", action: "click", target: {} }] });
    expect(result.success).toBe(false);
  });

  it("defaults setup and cleanup to empty", () => {
    const w = WorkflowSchema.parse({ ...base, steps: [{ id: "a", description: "x", action: "navigate", url: "/" }] });
    expect(w.setup).toEqual([]);
    expect(w.cleanup).toEqual([]);
  });
});

describe("frame rate and resolution", () => {
  it("renders at 60 fps and 1080p unless the product file says otherwise", () => {
    const { config } = parseProductFile("---\nurl: https://acme.test\n---\n\n# Acme\n", "acme.md", "acme");
    expect([config.demo.fps, config.demo.default_resolution]).toEqual([60, "1080p"]);
    const chosen = parseProductFile("---\nurl: https://acme.test\nfps: 30\nresolution: 4k\n---\n\n# Acme\n", "acme.md", "acme").config;
    expect([chosen.demo.fps, chosen.demo.default_resolution]).toEqual([30, "4k"]);
    expect(() => parseProductFile("---\nurl: https://acme.test\nfps: 50\n---\n\n# Acme\n", "acme.md", "acme")).toThrow(/fps is 30 or 60/);
  });
});
