export * from "./generator/script-writer";
export * from "./generator/synthesize";
export { createTTSProvider, registerTTSProvider, ElevenLabsTTS, OpenAITTS, ELEVENLABS_DEFAULTS, OPENAI_TTS_DEFAULTS } from "./providers/tts";
export type { TTSProvider, TTSFactory } from "./providers/tts";
export * from "./synchronization/pacer";
