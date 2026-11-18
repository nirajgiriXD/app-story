import { BlogPostSchema, type BlogPost, type Step, type Tone, type VideoKind, type Workflow } from "@app-story/contracts";
import { PHASE_EFFORT, type AIProvider, type ImageInput } from "../contracts/types";
import { loadPrompt } from "../prompts";
import { formatProductContext, type ProductContext } from "./context";

/** A screenshot offered to the writer: the steps it was taken right after. */
export interface BlogShot {
  /** 1-based; what `sections[].shot` refers to. */
  index: number;
  stepIds: string[];
  /** The narration line spoken over those steps, if any. */
  line?: string;
  image: ImageInput;
}

export interface BlogPostRequest {
  provider: AIProvider;
  product: ProductContext;
  workflow: Workflow;
  kind?: VideoKind;
  tone?: Tone;
  audience?: string;
  language: string;
  /** The voice-over, in order (intro, lines, outro). */
  narration: string[];
  shots: BlogShot[];
}

/** Longer product files are cut, as for the other prompts. */
const MAX_BRIEF_CHARS = 40_000;

const KIND_GUIDANCE: Record<VideoKind, string> = {
  "whats-new": "An announcement of what is new in this release: present each feature as something the reader can now do, and why it helps.",
  feature: "A spotlight on one feature: what it is for, the value it brings, and how it works end to end.",
  "how-to": "A tutorial: a clear sequence the reader can repeat on their own.",
};

const TONE_GUIDANCE: Record<Tone, string> = {
  calm: "Calm and clear, like product documentation with a human voice. No exclamation marks, no hype.",
  friendly: "Warm and approachable, like a teammate sharing a feature they love. Light enthusiasm.",
  energetic: "Confident and punchy, like a launch post. Lead with the benefit, short sentences, vivid verbs.",
};

/** The step as the writer sees it: what happens, in which section, what is typed and what it proves. */
function describeStep(step: Step): string {
  const parts = [`- ${step.id} [${step.action}${step.section ? `, section "${step.section}"` : ""}]`, step.description];
  const hidden = step.secret || /\{\{\s*env:/.test(step.value ?? "");
  if (step.value !== undefined && (step.action === "fill" || step.action === "select")) {
    parts.push(hidden ? "(secret value, never write it)" : `- value: "${step.value}"`);
  }
  if (step.expected) {
    const proof = [step.expected.description, step.expected.text && `"${step.expected.text}"`].filter(Boolean).join(" ");
    if (proof) parts.push(`- shows: ${proof}`);
  }
  return parts.join(" ");
}

/**
 * Write a blog post about a demo from its verified steps, its voice-over and screenshots of
 * the recording. The answer is checked: screenshots that were not offered, or are used twice,
 * are dropped.
 */
export async function writeBlogPost(request: BlogPostRequest): Promise<BlogPost> {
  const { workflow } = request;
  const brief = request.product.brief
    ?.trim()
    .slice(0, MAX_BRIEF_CHARS)
    .replace(/<\/?product_file>/gi, "");
  const shots = request.shots.map((s) => `${s.index}. After steps ${s.stepIds.join(", ")}${s.line ? `, while the voice says: "${s.line}"` : ""}`);
  const prompt = [
    formatProductContext({ ...request.product, brief: undefined }),
    brief ? `# Product file (from the team that owns the product)\n<product_file>\n${brief}\n</product_file>` : "",
    `# Video\nTitle: ${workflow.title}\nObjective: ${workflow.objective}${workflow.summary ? `\nSummary: ${workflow.summary}` : ""}`,
    request.kind ? `# Kind of post\n${KIND_GUIDANCE[request.kind]}` : "",
    `# Tone\n${TONE_GUIDANCE[request.tone ?? "calm"]}`,
    `# Audience\n${request.audience ?? workflow.audience ?? "Users of the product"}`,
    request.narration.length ? `# Voice-over\n${request.narration.map((line) => `- ${line}`).join("\n")}` : "",
    `# Verified steps, in order\n${workflow.steps.map(describeStep).join("\n")}`,
    shots.length ? `# Screenshots, in the order of the images\n${shots.join("\n")}` : "# Screenshots\nNone: set every `shot` to null.",
    `# Requirements\nLanguage: ${request.language}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const post = await request.provider.generateStructuredOutput({
    system: loadPrompt("blog-post"),
    prompt,
    schema: BlogPostSchema,
    schemaName: "blog_post",
    effort: PHASE_EFFORT.blog,
    images: request.shots.map((s) => s.image),
  });
  return normalizePost(
    post,
    request.shots.map((s) => s.index),
  );
}

/** Trim the answer, and keep only screenshots that were offered, each once. */
export function normalizePost(post: BlogPost, offered: readonly number[]): BlogPost {
  const left = new Set(offered);
  return {
    title: post.title.trim(),
    description: post.description.trim(),
    tags: [...new Set(post.tags.map((t) => t.trim()).filter(Boolean))],
    intro: post.intro.trim(),
    sections: post.sections
      .map((s) => {
        const shot = s.shot !== null && left.delete(s.shot) ? s.shot : null;
        return { heading: s.heading.replace(/^#+\s*/, "").trim(), body: s.body.trim(), shot, alt: shot === null ? null : (s.alt?.trim() ?? null) };
      })
      .filter((s) => s.heading || s.body),
    closing: post.closing.trim(),
  };
}
