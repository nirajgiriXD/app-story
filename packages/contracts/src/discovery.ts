import { z } from "zod";

/** Discovery output. Strict-output friendly: every field is required. */
export const DiscoveryReportSchema = z.object({
  overview: z.string().describe("What the application is and how it is organised."),
  navigation: z.array(z.object({ label: z.string(), path: z.string() })),
  features: z.array(z.object({ name: z.string(), description: z.string(), location: z.string() })),
  journeys: z.array(z.object({ title: z.string(), steps: z.array(z.string()) })),
  proposed_scenarios: z.array(
    z.object({
      id: z.string().describe("lowercase-dashed id"),
      title: z.string(),
      objective: z.string(),
      audience: z.string(),
      estimated_duration_s: z.number(),
    }),
  ),
  missing_information: z.array(z.string()),
  recommended_test_data: z.array(z.string()),
});
export type DiscoveryReport = z.infer<typeof DiscoveryReportSchema>;
