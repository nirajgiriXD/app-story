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
