import { z } from "zod";

/**
 * A blog post about a demo, as the AI writes it: from the verified steps of the video and
 * screenshots of the recording. Strict-output friendly: every field is required (nullable
 * where optional). The Markdown file around it (front matter, the video, the images) is
 * put together by AppStory, not by the AI.
 */
export const BlogPostSchema = z.object({
  title: z.string().describe("The post's headline: what the reader can do, in plain words. No colon-separated product prefix."),
  description: z.string().describe("One or two sentences for search results and link previews, at most 160 characters."),
  tags: z.array(z.string()).describe("Two to five short topic tags, lower case, e.g. 'project management'."),
  intro: z.string().describe("Markdown. One or two short paragraphs: the problem or goal, and what the post shows."),
  sections: z
    .array(
      z.object({
        heading: z.string().describe("A short heading for this part of the walkthrough, without '#'."),
        body: z.string().describe("Markdown paragraphs or a list. No headings, no images, no HTML."),
        shot: z.number().int().nullable().describe("The number of the screenshot to show after this section's text, or null for none."),
        alt: z.string().nullable().describe("Alt text for that screenshot: what it shows, in one sentence. Null when `shot` is null."),
      }),
    )
    .describe("The walkthrough, in the order of the steps."),
  closing: z.string().describe("Markdown. A short wrap-up: what the reader can now do, and why it helps. No link: AppStory adds the call to action."),
});
export type BlogPost = z.infer<typeof BlogPostSchema>;
