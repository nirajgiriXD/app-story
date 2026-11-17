import { z } from "zod";

/**
 * What the AI picks out of release notes written in any format. Strict-output friendly:
 * every field is required (nullable where optional).
 */
export const FeaturePlanSchema = z.object({
  title: z.string().nullable().describe("The release name or version, e.g. 'Release 2.4', or null if the notes have none."),
  features: z
    .array(
      z.object({
        // No .min(1): not every provider's strict mode accepts minLength. Empty titles are dropped after parsing.
        title: z.string().describe("Short feature name, in the notes' own words."),
        details: z.string().describe("Everything the notes say about this feature: what it does, where it is, how to use it. Never invent UI details."),
      }),
    )
    .describe("User-visible features worth showing on screen, in the order the notes list them."),
  skipped: z
    .array(z.object({ item: z.string().describe("The note, shortened."), reason: z.string().describe("Why it is not shown, in a few words.") }))
    .describe("Items left out, e.g. bug fixes with nothing to show, performance or internal changes."),
});
export type FeaturePlan = z.infer<typeof FeaturePlanSchema>;
export type Feature = FeaturePlan["features"][number];
