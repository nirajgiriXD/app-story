import { rm, writeFile } from "node:fs/promises";
import { resolveKokoroVoice, type TtsConfig } from "@showrun/contracts";
import { ShowrunError, runFfmpeg } from "@showrun/shared";
import type { KokoroTTS as KokoroModel } from "kokoro-js";
import type { TTSProvider } from "./tts";

export const KOKORO_DEFAULTS = {
  voice: "af_heart",
  /** Open-weight (Apache-2.0) 82M-parameter model, run locally on the CPU. */
  model: "onnx-community/Kokoro-82M-v1.0-ONNX",
  /** 8-bit weights: about 90 MB to download once, fast on a laptop CPU. */
  dtype: "q8",
} as const;

type KokoroModule = typeof import("kokoro-js");

/** One model per process: loading takes seconds, so every job and clip shares it. */
let loading: Promise<{ tts: KokoroModel; lib: KokoroModule }> | undefined;

function loadModel(model: string): Promise<{ tts: KokoroModel; lib: KokoroModule }> {
  loading ??= import("kokoro-js")
    .then(async (lib) => ({ lib, tts: await lib.KokoroTTS.from_pretrained(model, { dtype: KOKORO_DEFAULTS.dtype, device: "cpu" }) }))
    .catch((error: unknown) => {
      loading = undefined;
      throw new ShowrunError("TTS_ERROR", `Could not load the Kokoro voice model: ${(error as Error).message}`, {
        hint: "The first run downloads the model (~90 MB) from huggingface.co, so it needs internet once.",
        cause: error,
      });
    });
  return loading;
}

/**
 * Free text-to-speech that runs on this machine with the Kokoro model (kokoro-js).
 * No API key, so it works the same with Anthropic or OpenAI as the AI provider.
 * English voices only (American `af_*`/`am_*`, British `bf_*`/`bm_*`).
 */
export class KokoroTTS implements TTSProvider {
  readonly name = "kokoro";
  readonly voice: string;
  readonly model: string;
  /** The model is not safe to run in parallel, and parallel runs would not be faster on one CPU. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: TtsConfig) {
    // "female"/"male" (with the accent) or a voice name; unknown names fail at synthesis with the full list.
    this.voice = resolveKokoroVoice(config.voice, config.accent)?.id ?? config.voice ?? KOKORO_DEFAULTS.voice;
    this.model = config.model ?? KOKORO_DEFAULTS.model;
  }

  synthesize(text: string, outPath: string): Promise<void> {
    const run = this.queue.then(() => this.speak(text, outPath));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async speak(text: string, outPath: string): Promise<void> {
    const { tts, lib } = await loadModel(this.model);
    if (!(this.voice in tts.voices)) {
      throw new ShowrunError("CONFIG_INVALID", `Unknown Kokoro voice '${this.voice}'.`, {
        hint: `Use one of: ${Object.keys(tts.voices).join(", ")}`,
      });
    }
    const voice = this.voice as keyof typeof tts.voices;

    // Speak sentence by sentence, so long narration stays within the model's input limit.
    // The splitter is closed by hand: kokoro-js 1.2.1 never closes the one it makes from a
    // plain string, so its stream() would hang after the last sentence.
    const sentences = new lib.TextSplitterStream();
    sentences.push(text);
    sentences.close();
    const chunks: Float32Array[] = [];
    let sampleRate = 24_000;
    for await (const { audio } of tts.stream(sentences, { voice, speed: this.config.speed })) {
      chunks.push(audio.audio as Float32Array);
      sampleRate = audio.sampling_rate;
    }
    if (chunks.length === 0) throw new ShowrunError("TTS_ERROR", `Kokoro produced no audio for: "${text.slice(0, 80)}"`);

    const wav = `${outPath}.wav`;
    await writeFile(wav, encodeWav(chunks, sampleRate));
    try {
      await runFfmpeg(["-i", wav, "-c:a", "libmp3lame", "-b:a", "192k", outPath]);
    } finally {
      await rm(wav, { force: true });
    }
  }
}

/** 16-bit mono PCM WAV from float samples in [-1, 1]. */
function encodeWav(chunks: Float32Array[], sampleRate: number): Buffer {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  let offset = 44;
  for (const chunk of chunks) {
    for (const s of chunk) {
      buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), offset);
      offset += 2;
    }
  }
  return buffer;
}
