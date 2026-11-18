/**
 * The English voices of the free Kokoro model (kokoro-js 1.2), with the gender, accent and
 * quality grade its authors publish. Kept here, not read from the package, so settings can
 * be checked without loading the model.
 */
export const VOICE_GENDERS = ["female", "male"] as const;
export const VOICE_ACCENTS = ["american", "british"] as const;
export type VoiceGender = (typeof VOICE_GENDERS)[number];
export type VoiceAccent = (typeof VOICE_ACCENTS)[number];

export interface KokoroVoice {
  id: string;
  name: string;
  gender: VoiceGender;
  accent: VoiceAccent;
  grade: string;
}

const voice = (id: string, name: string, grade: string): KokoroVoice => ({
  id,
  name,
  gender: id[1] === "f" ? "female" : "male",
  accent: id[0] === "a" ? "american" : "british",
  grade,
});

export const KOKORO_VOICES: readonly KokoroVoice[] = [
  voice("af_heart", "Heart", "A"),
  voice("af_bella", "Bella", "A-"),
  voice("af_nicole", "Nicole", "B-"),
  voice("af_aoede", "Aoede", "C+"),
  voice("af_kore", "Kore", "C+"),
  voice("af_sarah", "Sarah", "C+"),
  voice("af_alloy", "Alloy", "C"),
  voice("af_nova", "Nova", "C"),
  voice("af_sky", "Sky", "C-"),
  voice("af_jessica", "Jessica", "D"),
  voice("af_river", "River", "D"),
  voice("am_michael", "Michael", "C+"),
  voice("am_fenrir", "Fenrir", "C+"),
  voice("am_puck", "Puck", "C+"),
  voice("am_echo", "Echo", "D"),
  voice("am_eric", "Eric", "D"),
  voice("am_liam", "Liam", "D"),
  voice("am_onyx", "Onyx", "D"),
  voice("am_santa", "Santa", "D-"),
  voice("am_adam", "Adam", "F+"),
  voice("bf_emma", "Emma", "B-"),
  voice("bf_isabella", "Isabella", "C"),
  voice("bf_alice", "Alice", "D"),
  voice("bf_lily", "Lily", "D"),
  voice("bm_george", "George", "C"),
  voice("bm_fable", "Fable", "C"),
  voice("bm_lewis", "Lewis", "D+"),
  voice("bm_daniel", "Daniel", "D"),
];

/**
 * The Kokoro voice for a setting: a gender ("female"/"male", best-graded voice for the
 * accent) or a voice id/name. Default: female, American. `undefined` for an unknown name.
 */
export function resolveKokoroVoice(setting: string | undefined, accent: VoiceAccent = "american"): KokoroVoice | undefined {
  const wanted = (setting ?? "female").trim().toLowerCase();
  if ((VOICE_GENDERS as readonly string[]).includes(wanted)) {
    // The list is ordered best grade first within each gender and accent.
    return KOKORO_VOICES.find((v) => v.gender === wanted && v.accent === accent);
  }
  return KOKORO_VOICES.find((v) => v.id === wanted || v.name.toLowerCase() === wanted);
}

/**
 * Languages the free local Chatterbox voice speaks: English with its original model, the
 * rest with Chatterbox Multilingual (also MIT licensed), loaded the first time one is needed.
 */
export const CHATTERBOX_LANGUAGES = [
  "ar",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fr",
  "he",
  "hi",
  "it",
  "ja",
  "ko",
  "ms",
  "nl",
  "no",
  "pl",
  "pt",
  "ru",
  "sv",
  "sw",
  "tr",
  "zh",
] as const;

/** The primary subtag of a language code: "pt" for "pt-BR". */
export function baseLanguage(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0] ?? code.toLowerCase();
}

/** True when a free local voice speaks `language`. Kokoro speaks English only. */
export function localVoiceSpeaks(provider: "kokoro" | "chatterbox", language: string): boolean {
  const code = baseLanguage(language);
  return provider === "kokoro" ? code === "en" : (CHATTERBOX_LANGUAGES as readonly string[]).includes(code);
}
