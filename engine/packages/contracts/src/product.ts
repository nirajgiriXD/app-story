import { z } from "zod";
import { VOICE_ACCENTS } from "./voices";

export const AI_PROVIDERS = ["anthropic", "openai"] as const;
export const AiProviderNameSchema = z.enum(AI_PROVIDERS);
export type AiProviderName = z.infer<typeof AiProviderNameSchema>;

/**
 * `kokoro` is free and runs locally (no API key), so it works with either AI provider.
 * `openai` and `elevenlabs` are optional paid voices. `none` makes a silent narration
 * track: the video still gets captions, paced to the text.
 */
export const TTS_PROVIDERS = ["kokoro", "openai", "elevenlabs", "none"] as const;
export const TtsProviderNameSchema = z.enum(TTS_PROVIDERS);
export type TtsProviderName = z.infer<typeof TtsProviderNameSchema>;

/** The video looks (templates) the renderer offers. */
export const TEMPLATE_NAMES = ["modern-saas", "minimal", "product-update", "tutorial", "feature-highlight"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** What a video is for, which decides its look when the product file sets no `template:`. */
export type VideoKind = "whats-new" | "feature" | "how-to";

const TEMPLATE_FOR_KIND: Record<VideoKind, TemplateName> = {
  "whats-new": "product-update", // all new features of a release: "New" badge, announcement feel
  feature: "feature-highlight", // one feature in focus: strongest zoom, big title
  "how-to": "tutorial", // a plain-language goal: big cursor, close zoom, easy to follow
};

/** The template for a video: the product file's choice, else one that suits the kind of video. */
export function pickTemplate(chosen: TemplateName | undefined, kind: VideoKind | undefined): TemplateName {
  return chosen ?? (kind ? TEMPLATE_FOR_KIND[kind] : "modern-saas");
}

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, numbers and dashes");

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "use a 6-digit hex color like #2563EB");

export const AiModelPricingSchema = z.object({
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
  cached_input_per_mtok: z.number().nonnegative().optional(),
});

export const AiProviderConfigSchema = z.object({
  provider: AiProviderNameSchema,
  /** Leave empty to use the provider's default model. */
  model: z.string().min(1).optional(),
  /** Reasoning effort. Mapped to each provider's own setting. */
  effort: EffortSchema.optional(),
  /** Only sent to models that accept it; most current reasoning models reject sampling params. */
  temperature: z.number().min(0).max(2).optional(),
  max_iterations: z.number().int().min(1).max(200).default(30),
  max_duration_s: z.number().int().min(30).max(3600).default(900),
  max_retries: z.number().int().min(0).max(10).default(4),
  pricing: AiModelPricingSchema.optional(),
});
export type AiProviderConfig = z.infer<typeof AiProviderConfigSchema>;

export const TtsConfigSchema = z.object({
  provider: TtsProviderNameSchema.default("kokoro"),
  /** Kokoro: "female", "male" or a voice id/name. OpenAI: a voice name. ElevenLabs: a voice id. */
  voice: z.string().optional(),
  /** Kokoro only: picks the best voice of the gender with this accent. */
  accent: z.enum(VOICE_ACCENTS).optional(),
  model: z.string().optional(),
  /** 1.0 is natural speed. */
  speed: z.number().min(0.7).max(1.3).default(1),
  /** Tone and delivery guidance, e.g. "warm and upbeat" (OpenAI only). */
  style: z.string().optional(),
});
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

const NoAuthSchema = z.object({ strategy: z.literal("none") });
/**
 * Fill the app's own login form, found automatically. `username` and `password` are
 * either the value itself or `env:NAME` (read from the environment at login time).
 */
const AutoAuthSchema = z.object({
  strategy: z.literal("auto"),
  username: z.string().min(1),
  password: z.string().min(1),
  /** Page with the login form. Default: the start page, then common paths such as /login. */
  login_path: z.string().optional(),
});
export const AuthConfigSchema = z.discriminatedUnion("strategy", [NoAuthSchema, AutoAuthSchema]);
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const SafetyConfigSchema = z
  .object({
    /** `production` makes the browser read-only: no typing, selecting, or button clicks. */
    environment: z.enum(["demo", "staging", "production"]).default("demo"),
    allow: z
      .object({
        delete: z.boolean().default(false),
        payments: z.boolean().default(false),
        emails: z.boolean().default(false),
        publishing: z.boolean().default(false),
        account_settings: z.boolean().default(false),
        invite_users: z.boolean().default(false),
        production_data: z.boolean().default(false),
      })
      .prefault({}),
    /** Extra words; any element whose name contains one is never clicked. */
    blocked_keywords: z.array(z.string()).default([]),
  })
  .prefault({});
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

export const RESOLUTIONS = { "720p": [1280, 720], "1080p": [1920, 1080], "1440p": [2560, 1440], "4k": [3840, 2160] } as const;
export const ResolutionSchema = z.enum(["720p", "1080p", "1440p", "4k"]);

export const ProductConfigSchema = z.object({
  version: z.literal(1),
  product: z.object({
    id: slug,
    name: z.string().min(1),
    description: z.string().min(1),
    base_url: z.url(),
    start_path: z.string().default("/"),
  }),
  browser: z
    .object({
      viewport: z.object({ width: z.number().int().min(320).default(1920), height: z.number().int().min(320).default(1080) }).prefault({}),
      device_scale_factor: z.number().min(1).max(3).default(1),
      /** Hostnames the browser may visit. Defaults to the base_url host. `*.example.com` allows subdomains. */
      allowed_domains: z.array(z.string()).default([]),
      locale: z.string().default("en-US"),
      timezone: z.string().default("UTC"),
      color_scheme: z.enum(["light", "dark"]).default("light"),
      headless: z.boolean().default(true),
      navigation_timeout_ms: z.number().int().positive().default(30_000),
      action_timeout_ms: z.number().int().positive().default(10_000),
    })
    .prefault({}),
  authentication: AuthConfigSchema.default({ strategy: "none" }),
  demo: z
    .object({
      default_language: z.string().default("en"),
      default_duration: z.number().int().positive().default(90),
      default_resolution: ResolutionSchema.default("1080p"),
      /** 60 keeps the cursor and the camera's moves smooth; 30 renders in half the time. */
      fps: z.number().int().min(24).max(60).default(60),
      /** Video look. Unset: picked per video (see `pickTemplate`). */
      template: z.enum(TEMPLATE_NAMES).optional(),
      audience: z.string().optional(),
    })
    .prefault({}),
  branding: z
    .object({
      logo: z.string().optional(),
      primary_color: hexColor.default("#2563EB"),
      accent_color: hexColor.default("#0F172A"),
      font: z.string().default("Inter"),
      background_music: z.string().optional(),
      music_volume: z.number().min(0).max(1).default(0.08),
    })
    .prefault({}),
  providers: z.object({
    ai: AiProviderConfigSchema,
    /** Optional and explicit. Used only when the primary provider fails, and always recorded. */
    ai_fallback: AiProviderConfigSchema.optional(),
    tts: TtsConfigSchema.prefault({}),
  }),
  safety: SafetyConfigSchema,
  recording: z
    .object({
      /** `cdp` captures sharp frames straight from Chromium; `playwright` uses Playwright's built-in recorder. */
      engine: z.enum(["cdp", "playwright"]).default("cdp"),
      jpeg_quality: z.number().int().min(50).max(100).default(92),
      min_step_ms: z.number().int().min(0).default(900),
      typing_delay_ms: z.number().int().min(0).default(45),
      cursor_move_ms: z.number().int().min(0).default(650),
      trace: z.boolean().default(true),
    })
    .prefault({}),
  captions: z
    .object({
      enabled: z.boolean().default(true),
      burn_in: z.boolean().default(true),
      font_size: z.number().int().min(16).max(96).default(38),
      position: z.enum(["bottom", "top"]).default("bottom"),
      max_chars_per_line: z.number().int().min(20).max(80).default(52),
    })
    .prefault({}),
});

export type ProductConfig = z.infer<typeof ProductConfigSchema>;
export type ProductConfigInput = z.input<typeof ProductConfigSchema>;
