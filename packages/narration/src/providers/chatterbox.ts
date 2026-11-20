import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { baseLanguage, CHATTERBOX_LANGUAGES, type TtsConfig } from "@app-story/contracts";
import { AppStoryError, serialQueue } from "@app-story/shared";
import type { TTSProvider } from "./tts";

/*
 * Chatterbox (Resemble AI, MIT licence): a free, natural-sounding voice that can also copy
 * a voice from a short recording, in English and 22 more languages (Chatterbox
 * Multilingual). It runs in Python, so AppStory starts a small helper
 * (python/chatterbox_worker.py) once and sends it one line at a time.
 *
 *   pip install chatterbox-tts       (PyTorch included; a GPU helps but is not needed)
 *   APP_STORY_PYTHON=path/to/python  (default: python)
 *   APP_STORY_VOICE=my-voice.wav     (optional: a 10-20 s recording to copy)
 */

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = "chatterbox_worker.py";

/** The helper script: next to the bundle in the built package, in `python/` in the sources. */
export function chatterboxWorkerPath(): string {
  const candidates = [join(here, "python", WORKER), join(here, "..", "..", "python", WORKER)];
  return candidates.find((p) => existsSync(p)) ?? (candidates[1] as string);
}

const INSTALL_HINT = "Install it with `pip install chatterbox-tts` (set APP_STORY_PYTHON if that Python is not the one on PATH), or use `voice: kokoro`.";

type Reply = { ready?: boolean; ok?: boolean; error?: string };

/** One helper per process: loading the model takes a while, so every clip and job shares it. */
class Worker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly replies: ((reply: Reply) => void)[] = [];
  private readonly ready: Promise<void>;
  private stderr = "";
  private exited: Error | undefined;

  constructor(python: string) {
    this.child = spawn(python, ["-u", chatterboxWorkerPath()], { windowsHide: true });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-3000);
    });
    const lines = createInterface({ input: this.child.stdout });
    let markReady: (() => void) | undefined;
    let failReady: ((error: Error) => void) | undefined;
    this.ready = new Promise((ok, fail) => {
      markReady = ok;
      failReady = fail;
    });
    lines.on("line", (line) => {
      let reply: Reply;
      try {
        reply = JSON.parse(line) as Reply;
      } catch {
        return; // a library printing to stdout
      }
      if (reply.ready) return markReady?.();
      const next = this.replies.shift();
      if (next) next(reply);
      else if (reply.error) failReady?.(new AppStoryError("TTS_ERROR", `Chatterbox could not start: ${reply.error}`, { hint: INSTALL_HINT }));
    });
    this.child.on("error", (error: NodeJS.ErrnoException) => {
      this.exited =
        error.code === "ENOENT"
          ? new AppStoryError("DEPENDENCY_MISSING", `'${python}' was not found, and the Chatterbox voice runs in Python.`, { hint: INSTALL_HINT })
          : error;
      failReady?.(this.exited);
      for (const reply of this.replies.splice(0)) reply({ error: this.exited.message });
    });
    this.child.on("exit", (code) => {
      this.exited ??= new AppStoryError("TTS_ERROR", `The Chatterbox helper stopped (exit ${code}): ${this.stderr.trim().slice(-600)}`, {
        hint: INSTALL_HINT,
      });
      failReady?.(this.exited);
      for (const reply of this.replies.splice(0)) reply({ error: this.exited.message });
      worker = undefined;
    });
    // The helper keeps AppStory running only while it is working on a line, and goes when AppStory does.
    this.hold();
    process.once("exit", () => this.child.kill());
  }

  /** While a line is being spoken (or the model loads), AppStory waits for the helper. */
  private hold(): void {
    this.child.ref();
    (this.child.stdout as unknown as { ref?: () => void }).ref?.();
  }

  /** Idle: the helper alone never keeps AppStory running. */
  private release(): void {
    if (this.replies.length > 0) return;
    this.child.unref();
    (this.child.stdout as unknown as { unref?: () => void }).unref?.();
    (this.child.stderr as unknown as { unref?: () => void }).unref?.();
    (this.child.stdin as unknown as { unref?: () => void }).unref?.();
  }

  async speak(request: { text: string; out: string; voice?: string; exaggeration: number; language?: string }): Promise<void> {
    this.hold();
    try {
      await this.ready;
      if (this.exited) throw this.exited;
      const reply = await new Promise<Reply>((answer) => {
        this.replies.push(answer);
        this.child.stdin.write(`${JSON.stringify(request)}\n`);
      });
      if (!reply.ok) throw new AppStoryError("TTS_ERROR", `Chatterbox could not speak "${request.text.slice(0, 60)}": ${reply.error ?? "no answer"}`);
    } finally {
      this.release();
    }
  }
}

let worker: Worker | undefined;
/** One line at a time: the helper answers in order and the model does not run in parallel. */
const queue = serialQueue();

export class ChatterboxTTS implements TTSProvider {
  readonly name = "chatterbox";
  readonly voice: string;
  readonly model = "chatterbox";
  /** How expressive the delivery is (0.5 is neutral); `style: expressive` or a livelier tone raises it. */
  private readonly exaggeration: number;
  private readonly reference: string | undefined;

  constructor(config: TtsConfig) {
    // A voice that is an audio file is copied; anything else uses Chatterbox's own voice.
    this.reference = config.voice && /\.(wav|mp3|flac|ogg|m4a)$/i.test(config.voice) ? resolve(config.voice) : undefined;
    this.voice = this.reference ?? "default";
    this.exaggeration = config.style
      ? /expressive|energetic|upbeat/i.test(config.style)
        ? 0.7
        : 0.5
      : config.tone === "energetic"
        ? 0.7
        : config.tone === "friendly"
          ? 0.6
          : 0.5;
  }

  synthesize(text: string, outPath: string, options: { language?: string } = {}): Promise<void> {
    return queue(() => {
      worker ??= new Worker(process.env.APP_STORY_PYTHON?.trim() || "python");
      return worker.speak({ text, out: outPath, voice: this.reference, exaggeration: this.exaggeration, language: chatterboxLanguage(options.language) });
    });
  }
}

/**
 * The language a line is sent to the helper with: none for English (Chatterbox's original
 * model), else the code Chatterbox Multilingual knows ("pt" for "pt-BR").
 */
export function chatterboxLanguage(language = "en"): string | undefined {
  const code = baseLanguage(language);
  if (code === "en") return undefined;
  if (!(CHATTERBOX_LANGUAGES as readonly string[]).includes(code)) {
    throw new AppStoryError("CONFIG_INVALID", `The chatterbox voice does not speak '${language}'.`, {
      hint: `It speaks ${CHATTERBOX_LANGUAGES.join(", ")}. Use voice: openai or voice: elevenlabs for other languages.`,
    });
  }
  return code;
}
