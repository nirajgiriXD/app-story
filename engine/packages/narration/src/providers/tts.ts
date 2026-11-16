import { writeFile } from "node:fs/promises";
import OpenAI from "openai";
import type { TtsConfig } from "@demoforge/contracts";
import { DemoForgeError, registerSecret, retry, runFfmpeg } from "@demoforge/shared";
import { KokoroTTS } from "./kokoro";

export interface TTSProvider {
  readonly name: string;
  readonly voice: string;
  readonly model: string;
  /** True when the provider writes silence instead of speech (captions-only videos). */
  readonly silent?: boolean;
  /** Write speech audio (MP3) for `text` to `outPath`. */
  synthesize(text: string, outPath: string): Promise<void>;
}

export const ELEVENLABS_DEFAULTS = { voice: "JBFqnCBsd6RMkjVDRZzb", model: "eleven_multilingual_v2" };
export const OPENAI_TTS_DEFAULTS = {
  voice: "marin",
  model: "gpt-4o-mini-tts",
  style: "Calm, clear and friendly, like a product specialist walking a customer through the app.",
};

export class ElevenLabsTTS implements TTSProvider {
  readonly name = "elevenlabs";
  readonly voice: string;
  readonly model: string;

  constructor(
    private readonly config: TtsConfig,
    private readonly apiKey: string,
  ) {
    this.voice = config.voice ?? ELEVENLABS_DEFAULTS.voice;
    this.model = config.model ?? ELEVENLABS_DEFAULTS.model;
  }

  async synthesize(text: string, outPath: string): Promise<void> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voice)}?output_format=mp3_44100_128`;
    const audio = await retry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "xi-api-key": this.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
          body: JSON.stringify({
            text,
            model_id: this.model,
            voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: this.config.speed },
          }),
        });
        if (res.status === 401 || res.status === 403) {
          throw new DemoForgeError("PROVIDER_AUTH", "ElevenLabs rejected the API key.", { hint: "Check ELEVENLABS_API_KEY in .env." });
        }
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          throw new DemoForgeError("TTS_ERROR", `ElevenLabs returned HTTP ${res.status}: ${body}`, {
            retryable: res.status === 429 || res.status >= 500,
          });
        }
        return Buffer.from(await res.arrayBuffer());
      },
      { retries: 3, baseDelayMs: 1500, shouldRetry: (e) => e instanceof DemoForgeError && e.retryable },
    );
    await writeFile(outPath, audio);
  }
}

export class OpenAITTS implements TTSProvider {
  readonly name = "openai";
  readonly voice: string;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(private readonly config: TtsConfig) {
    this.voice = config.voice ?? OPENAI_TTS_DEFAULTS.voice;
    this.model = config.model ?? OPENAI_TTS_DEFAULTS.model;
    this.client = new OpenAI({ maxRetries: 4 });
  }

  async synthesize(text: string, outPath: string): Promise<void> {
    try {
      const response = await this.client.audio.speech.create({
        model: this.model,
        voice: this.voice,
        input: text,
        response_format: "mp3",
        instructions: this.model.startsWith("tts-1") ? undefined : (this.config.style ?? OPENAI_TTS_DEFAULTS.style),
        ...(this.config.speed !== 1 ? { speed: this.config.speed } : {}),
      });
      await writeFile(outPath, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) {
        throw new DemoForgeError("PROVIDER_AUTH", "OpenAI rejected the API key for text-to-speech.", { hint: "Check OPENAI_API_KEY." });
      }
      if (error instanceof OpenAI.APIError) {
        throw new DemoForgeError("TTS_ERROR", `OpenAI text-to-speech failed: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }
}

/** Natural speaking rate, used to size silent clips so captions stay on screen long enough to read. */
const SILENT_WORDS_PER_SECOND = 2.5;

/**
 * No speech: writes a silent clip as long as the text would take to say. The rest of the
 * pipeline (pacing, captions, render) works unchanged, so the video carries captions only.
 */
export class SilentTTS implements TTSProvider {
  readonly name = "none";
  readonly voice = "none";
  readonly model = "silence";
  readonly silent = true;

  async synthesize(text: string, outPath: string): Promise<void> {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const seconds = Math.max(1.5, words / SILENT_WORDS_PER_SECOND + 0.4);
    await runFfmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", seconds.toFixed(2), "-c:a", "libmp3lame", "-b:a", "128k", outPath]);
  }
}

export type TTSFactory = (config: TtsConfig) => TTSProvider;

function openaiTTS(config: TtsConfig): TTSProvider {
  if (!process.env.OPENAI_API_KEY) {
    throw new DemoForgeError("PROVIDER_AUTH", "OPENAI_API_KEY is not set (needed for OpenAI text-to-speech).", {
      hint: "Add it to .env, or use the free local voice: `voice: kokoro` in the product file.",
    });
  }
  return new OpenAITTS(config);
}

const factories = new Map<string, TTSFactory>([
  [
    "elevenlabs",
    (config) => {
      const key = process.env.ELEVENLABS_API_KEY;
      if (!key) {
        throw new DemoForgeError("PROVIDER_AUTH", "ELEVENLABS_API_KEY is not set.", {
          hint: "Add it to .env, or use the free local voice: `voice: kokoro` in the product file.",
        });
      }
      registerSecret(key);
      return new ElevenLabsTTS(config, key);
    },
  ],
  ["openai", openaiTTS],
  ["kokoro", (config) => new KokoroTTS(config)],
  ["none", () => new SilentTTS()],
]);

export function registerTTSProvider(name: string, factory: TTSFactory): void {
  factories.set(name, factory);
}

export function createTTSProvider(config: TtsConfig): TTSProvider {
  const factory = factories.get(config.provider);
  if (!factory) throw new DemoForgeError("CONFIG_INVALID", `Unknown TTS provider '${config.provider}'.`);
  return factory(config);
}
