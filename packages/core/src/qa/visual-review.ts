import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { VisualReviewSchema, type VisualReview, type Workflow } from "@app-story/contracts";
import { PHASE_EFFORT, loadPrompt, type ImageInput } from "@app-story/ai";
import { runFfmpeg } from "@app-story/shared";
import type { Job } from "../job-manager/job";
import type { ComposeResult } from "../pipeline/compose";

/** More frames than this cost more than they tell: lines are sampled evenly. */
const MAX_FRAMES = 12;

/** The review is on unless APP_STORY_AI_REVIEW=off. */
export function visualReviewEnabled(): boolean {
  return !/^(off|false|0|no)$/i.test(process.env.APP_STORY_AI_REVIEW?.trim() ?? "");
}

export interface ReviewedLine {
  index: number;
  text: string;
  stepIds: string[];
  atMs: number;
}

/** The narration lines to look at, and the moment of each: past the middle of the line, when its action shows. */
export function linesToReview(lines: ComposeResult["lines"]): ReviewedLine[] {
  const step = Math.max(1, lines.length / MAX_FRAMES);
  const picked: ReviewedLine[] = [];
  for (let i = 0; i < lines.length && picked.length < MAX_FRAMES; i += step) {
    const line = lines[Math.floor(i)] as ComposeResult["lines"][number];
    picked.push({ index: picked.length + 1, text: line.text, stepIds: line.stepIds, atMs: line.startMs + line.durationMs * 0.6 });
  }
  return picked;
}

/** Frames of the finished video at each line's moment, small enough to send. */
export async function grabFrames(job: Job, lines: readonly ReviewedLine[]): Promise<ImageInput[]> {
  const images: ImageInput[] = [];
  for (const line of lines) {
    const file = join(job.paths.videoDir, `review-${line.index}.jpg`);
    await runFfmpeg(["-ss", (line.atMs / 1000).toFixed(3), "-i", job.paths.finalVideo, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", file]);
    images.push({ mediaType: "image/jpeg", data: await readFile(file) });
    await rm(file, { force: true });
  }
  return images;
}

export function reviewPrompt(workflow: Workflow, lines: readonly ReviewedLine[]): string {
  return [`# Video\n${workflow.title}`, "# Frames, in the order of the images", ...lines.map((l) => `${l.index}. Narration: "${l.text}"`)].join("\n");
}

/** The steps whose shot failed the review: shown wide on the next render. */
export function stepsToShowWide(review: VisualReview, lines: readonly ReviewedLine[]): { stepIds: string[]; issues: string[] } {
  const stepIds = new Set<string>();
  const issues: string[] = [];
  for (const frame of review.frames) {
    const line = lines.find((l) => l.index === frame.index);
    if (!line || (frame.subject_visible && !frame.text_cut_off)) continue;
    for (const id of line.stepIds) stepIds.add(id);
    issues.push(`line ${frame.index}: ${frame.issue ?? (frame.subject_visible ? "text cut off" : "subject not on screen")}`);
  }
  return { stepIds: [...stepIds], issues };
}

export const REVIEW_REQUEST = { system: () => loadPrompt("review"), schema: VisualReviewSchema, schemaName: "visual_review", effort: PHASE_EFFORT.review };
