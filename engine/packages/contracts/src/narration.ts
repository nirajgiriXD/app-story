import { z } from "zod";

/**
 * Narration as written by the AI (or the scenario author).
 * All fields are required (nullable where optional) so the same schema works with
 * strict structured outputs on both Anthropic and OpenAI.
 */
export const NarrationScriptSchema = z.object({
  intro: z.string().describe("One or two sentences spoken over the title card."),
  segments: z
    .array(
      z.object({
        step_ids: z.array(z.string()).describe("Contiguous step ids this line covers, in order."),
        text: z.string().describe("What the narrator says while these steps play."),
      }),
    )
    .min(1),
  outro: z.string().describe("One closing sentence spoken over the end card."),
});
export type NarrationScript = z.infer<typeof NarrationScriptSchema>;

/**
 * The narration and the title cards' words in another language, line for line: `segments[i]`
 * is the translation of the original's segment i, with its `{{@step}}` anchors kept.
 * All fields required (nullable where optional), for strict structured outputs.
 */
export const NarrationTranslationSchema = z.object({
  title: z.string().describe("The video's title."),
  summary: z.string().nullable().describe("The subtitle under the title, or null if the original has none."),
  intro: z.string(),
  segments: z.array(z.string()).describe("One per original segment, in the same order."),
  outro: z.string(),
  cta: z.string().describe('The end card\'s call to action, keeping the "{host}" placeholder.'),
  badge: z.string().nullable().describe("The title card's badge (e.g. New), or null if the original has none."),
});
export type NarrationTranslation = z.infer<typeof NarrationTranslationSchema>;

/** When a word is spoken, in ms from the start of its clip. */
export const WordTimingSchema = z.object({ text: z.string(), start_ms: z.number(), end_ms: z.number() });
export type WordTiming = z.infer<typeof WordTimingSchema>;

export const AudioClipSchema = z.object({
  id: z.string(),
  kind: z.enum(["intro", "segment", "outro"]),
  text: z.string(),
  step_ids: z.array(z.string()),
  path: z.string(),
  duration_ms: z.number(),
  /** Every word of `text` with when it is spoken, when word timing ran. */
  words: z.array(WordTimingSchema).optional(),
  /** Later steps of the line that land on a word: when, in ms from the clip's start (see narration's anchors.ts). */
  anchors: z.array(z.object({ step_id: z.string(), at_ms: z.number() })).optional(),
});

export type AudioClip = z.infer<typeof AudioClipSchema>;

/** A narration clip placed on the recording timeline. */
export const PlacedClipSchema = AudioClipSchema.extend({ start_ms: z.number() });
export type PlacedClip = z.infer<typeof PlacedClipSchema>;

export const CaptionCueSchema = z.object({ index: z.number().int(), start_ms: z.number(), end_ms: z.number(), text: z.string() });
export type CaptionCue = z.infer<typeof CaptionCueSchema>;
