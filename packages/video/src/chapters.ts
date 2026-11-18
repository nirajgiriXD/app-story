import type { RenderProps } from "./props";

/*
 * Chapters of a finished video, from its sections: written into the MP4 (players list them)
 * and as YouTube chapter lines, ready to paste into a description.
 */

export interface Chapter {
  /** Global ms. */
  startMs: number;
  title: string;
}

/** Sections closer together than this are one chapter: a chapter must be worth jumping to. */
const MIN_CHAPTER_MS = 4000;

/** The video's chapters: the title card, then each section of the recording. */
export function chaptersOf(props: Pick<RenderProps, "title" | "sections" | "recording" | "durationMs">): Chapter[] {
  const chapters: Chapter[] = [{ startMs: 0, title: props.title }];
  for (const section of props.sections) {
    const startMs = Math.round(props.recording.startMs + section.atMs);
    const last = chapters[chapters.length - 1] as Chapter;
    if (startMs - last.startMs < MIN_CHAPTER_MS) {
      // Too close to the one before: the later title names what follows better.
      if (chapters.length > 1) last.title = section.title;
      continue;
    }
    if (startMs < props.durationMs - MIN_CHAPTER_MS) chapters.push({ startMs, title: section.title });
  }
  return chapters;
}

/** FFmpeg's metadata file with the chapters, for `-map_chapters`. */
export function ffmetadata(chapters: readonly Chapter[], durationMs: number): string {
  const escape = (text: string) => text.replace(/[=;#\\\n]/g, (c) => (c === "\n" ? " " : `\\${c}`));
  const lines = [";FFMETADATA1"];
  chapters.forEach((chapter, i) => {
    const end = chapters[i + 1]?.startMs ?? durationMs;
    lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${chapter.startMs}`, `END=${Math.max(chapter.startMs + 1, end)}`, `title=${escape(chapter.title)}`);
  });
  return `${lines.join("\n")}\n`;
}

/** YouTube's chapter rules: the first at 0:00, at least three, each at least ten seconds long. */
const YOUTUBE_MIN_CHAPTERS = 3;
const YOUTUBE_MIN_MS = 10_000;

/** The chapters as YouTube description lines ("0:00 Title"), or none when YouTube would not show them. */
export function youtubeChapters(chapters: readonly Chapter[], durationMs: number): string[] {
  const lengths = chapters.map((c, i) => (chapters[i + 1]?.startMs ?? durationMs) - c.startMs);
  if (chapters.length < YOUTUBE_MIN_CHAPTERS || lengths.some((ms) => ms < YOUTUBE_MIN_MS)) return [];
  return chapters.map((c) => `${clock(c.startMs)} ${c.title}`);
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
