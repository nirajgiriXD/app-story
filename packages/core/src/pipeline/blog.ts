import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlogPost, StepResult } from "@app-story/contracts";
import { writeBlogPost, type AIProvider, type BlogShot } from "@app-story/ai";
import type { LoadedProduct } from "@app-story/products";
import { ensureDir, runFfmpeg } from "@app-story/shared";
import { DEFAULT_CTA } from "@app-story/video";
import type { ExtraFile } from "../job-manager/job";
import type { Take } from "./takes";

/*
 * A blog post to publish with the video: written by the AI from the verified steps, the
 * voice-over and screenshots of the app, then put together here as Markdown with front
 * matter, the video embedded, and the screenshots next to it. The screenshots come from the
 * raw recording (no pointer, no zoom, no captions): the app as the reader will see it.
 */

/** `APP_STORY_BLOG=off` makes videos without a blog post. */
export function blogEnabled(): boolean {
  return !/^(off|false|0|no)$/i.test(process.env.APP_STORY_BLOG?.trim() ?? "");
}

/** At most this many screenshots are offered to the writer (each is sent as an image). */
const MAX_SHOTS = 8;
/** A screenshot is taken this long after its last step ended: the outcome has settled on screen. */
const SETTLE_MS = 300;
/** Screenshots in the post are at most this wide (the recording is captured at 2x). */
const SHOT_WIDTH = 1920;
/** The images the writer looks at are smaller: enough to read the page, cheap to send. */
const PREVIEW_WIDTH = 1280;

export interface ShotMoment {
  index: number;
  stepIds: string[];
  line?: string;
  /** Ms on the recording's clock. */
  atMs: number;
}

/**
 * The moments worth a screenshot: right after the steps of each narration line (what the line
 * is about is then on screen), or of each section when there is no voice. Evenly thinned to
 * `MAX_SHOTS`.
 */
export function shotMoments(take: Pick<Take, "workflow" | "clips" | "recorded">): ShotMoment[] {
  const passed = new Map<string, StepResult>();
  for (const step of take.recorded.report.steps) if (step.status === "passed") passed.set(step.step_id, step);
  const lines = take.clips.filter((c) => c.kind === "segment" && c.step_ids.length);
  const groups: { stepIds: string[]; line?: string }[] = lines.length
    ? lines.map((c) => ({ stepIds: c.step_ids, line: c.text.replace(/\{\{@[^}]*\}\}/g, "") }))
    : bySection(take.workflow.steps);

  const durationMs = take.recorded.recording.durationMs;
  const moments: Omit<ShotMoment, "index">[] = [];
  for (const group of groups) {
    const last = [...group.stepIds].reverse().find((id) => passed.has(id));
    if (!last) continue;
    const atMs = Math.max(0, Math.min((passed.get(last) as StepResult).ended_ms + SETTLE_MS, durationMs - 100));
    moments.push({ ...group, atMs });
  }
  const every = Math.max(1, moments.length / MAX_SHOTS);
  const picked: ShotMoment[] = [];
  for (let i = 0; i < moments.length && picked.length < MAX_SHOTS; i += every) {
    picked.push({ ...(moments[Math.floor(i)] as ShotMoment), index: picked.length + 1 });
  }
  return picked;
}

function bySection(steps: Take["workflow"]["steps"]): { stepIds: string[] }[] {
  const groups: { section: string | undefined; stepIds: string[] }[] = [];
  for (const step of steps) {
    const last = groups.at(-1);
    if (last && last.section === step.section) last.stepIds.push(step.id);
    else groups.push({ section: step.section, stepIds: [step.id] });
  }
  return groups.map(({ stepIds }) => ({ stepIds }));
}

export async function grabShot(recording: string, atMs: number, file: string, width: number): Promise<void> {
  const quality = file.endsWith(".jpg") ? ["-q:v", "3"] : [];
  await runFfmpeg(["-ss", (atMs / 1000).toFixed(3), "-i", recording, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, ...quality, "-update", "1", file]);
}

export interface BlogPage {
  /** The video's file name without its extension (`<job>-<name>`): the post links to the files next to it. */
  base: string;
  /** The video and its thumbnail are next to the post. */
  video: boolean;
  poster: boolean;
  /** The screenshot file of each shot the post shows, by shot number. */
  images: Map<number, string>;
  /** YYYY-MM-DD. */
  date: string;
  cta?: { text: string; url: string };
}

/** The post as Markdown with front matter, ready for a static site, a CMS import or a paste. */
export function blogMarkdown(post: BlogPost, page: BlogPage): string {
  const q = (text: string) => JSON.stringify(text); // a JSON string is a valid YAML scalar
  const firstImage = post.sections.map((s) => (s.shot === null ? undefined : page.images.get(s.shot))).find(Boolean);
  const image = page.poster ? `${page.base}.png` : firstImage;
  const front = [
    "---",
    `title: ${q(post.title)}`,
    `description: ${q(post.description)}`,
    `date: ${page.date}`,
    post.tags.length ? `tags: [${post.tags.map(q).join(", ")}]` : "",
    image ? `image: ${q(image)}` : "",
    page.video ? `video: ${q(`${page.base}.mp4`)}` : "",
    "---",
  ].filter(Boolean);

  const parts = [front.join("\n"), post.intro];
  if (page.video) {
    const poster = page.poster ? ` poster="${page.base}.png"` : "";
    parts.push(`<video src="${page.base}.mp4"${poster} controls preload="metadata" playsinline></video>`);
  }
  for (const section of post.sections) {
    parts.push(`## ${section.heading}`, section.body);
    const file = section.shot === null ? undefined : page.images.get(section.shot);
    if (file) parts.push(`![${(section.alt ?? section.heading).replace(/[[\]]/g, "")}](${file})`);
  }
  parts.push(post.closing);
  if (page.cta) parts.push(`[${page.cta.text}](${page.cta.url})`);
  return `${parts.filter((p) => p.trim()).join("\n\n")}\n`;
}

/** The end card's call to action, as a link to the product's public website (or the app). */
export function blogCta(product: LoadedProduct): { text: string; url: string } {
  const { config } = product;
  const url = config.product.website ?? config.product.base_url;
  return { text: (config.branding.cta ?? DEFAULT_CTA).replace("{host}", new URL(url).host), url };
}

export interface MakeBlogInput {
  product: LoadedProduct;
  take: Pick<Take, "workflow" | "clips" | "recorded" | "kind" | "objective">;
  /** Where the post and its screenshots are written before they are delivered. */
  workDir: string;
  page: Omit<BlogPage, "images" | "date">;
  /** Runs the AI request: with the job's provider fallback, or the CLI's. */
  generate: (write: (provider: AIProvider) => Promise<BlogPost>) => Promise<BlogPost>;
  date?: Date;
}

/**
 * Write the post: screenshots of the recording for the AI to look at, the AI's post, then the
 * Markdown and the screenshots it shows. Returns the files, named by the suffix they are
 * delivered with (`.blog.md`, `.blog-1.png`, …), next to the video.
 */
export async function makeBlogPost(input: MakeBlogInput): Promise<ExtraFile[]> {
  const { product, take, workDir } = input;
  const config = product.config;
  const recording = take.recorded.recording.path;
  await ensureDir(workDir);

  const moments = shotMoments(take);
  const shots: BlogShot[] = [];
  for (const moment of moments) {
    const file = join(workDir, `preview-${moment.index}.jpg`);
    await grabShot(recording, moment.atMs, file, PREVIEW_WIDTH);
    shots.push({ index: moment.index, stepIds: moment.stepIds, line: moment.line, image: { mediaType: "image/jpeg", data: await readFile(file) } });
    await rm(file, { force: true });
  }

  const narration = take.clips.map((c) => c.text.replace(/\{\{@[^}]*\}\}/g, "").trim()).filter(Boolean);
  const post = await input.generate((provider) =>
    writeBlogPost({
      provider,
      product: {
        name: config.product.name,
        description: config.product.description,
        baseUrl: config.product.base_url,
        website: config.product.website,
        brief: product.brief,
      },
      workflow: take.workflow,
      kind: take.kind ?? undefined,
      tone: config.demo.tone,
      audience: config.demo.audience,
      language: config.demo.default_language,
      narration,
      shots,
    }),
  );

  // The screenshots the post shows, numbered in the order they appear.
  const files: ExtraFile[] = [];
  const images = new Map<number, string>();
  for (const section of post.sections) {
    const moment = section.shot === null ? undefined : moments.find((m) => m.index === section.shot);
    if (!moment) continue;
    const suffix = `.blog-${images.size + 1}.png`;
    const file = join(workDir, suffix.slice(1));
    await grabShot(recording, moment.atMs, file, SHOT_WIDTH);
    images.set(moment.index, `${input.page.base}${suffix}`);
    files.push({ file, suffix });
  }

  const markdown = join(workDir, "blog.md");
  const date = (input.date ?? new Date()).toISOString().slice(0, 10);
  await writeFile(markdown, blogMarkdown(post, { ...input.page, images, date, cta: input.page.cta ?? blogCta(product) }), "utf8");
  return [{ file: markdown, suffix: ".blog.md" }, ...files];
}
