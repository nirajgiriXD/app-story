import type { CaptionCue } from "@showrun/contracts";

export interface TimedText {
  text: string;
  start_ms: number;
  duration_ms: number;
}

export interface CueOptions {
  maxCharsPerLine: number;
  maxLines: number;
  /** Minimum time a cue stays on screen. */
  minCueMs?: number;
}

/** Split text into sentences, then into chunks that fit on screen. */
export function chunkText(text: string, maxChars: number): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?;])\s+/)
    .filter(Boolean);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      chunks.push(sentence);
      continue;
    }
    // Break long sentences at commas first, then at word boundaries.
    const parts = sentence.split(/(?<=,)\s+/);
    let current = "";
    for (const part of parts) {
      for (const word of part.split(" ")) {
        const next = current ? `${current} ${word}` : word;
        if (next.length > maxChars && current) {
          chunks.push(current);
          current = word;
        } else current = next;
      }
      if (current.length > maxChars * 0.6) {
        chunks.push(current);
        current = "";
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

/** Wrap a chunk into at most `maxLines` balanced lines. */
export function wrapLines(text: string, maxCharsPerLine: number): string {
  if (text.length <= maxCharsPerLine) return text;
  const words = text.split(" ");
  const target = text.length / 2;
  let first = "";
  for (const word of words) {
    const next = first ? `${first} ${word}` : word;
    if (next.length > target && first) break;
    first = next;
  }
  return `${first}\n${text.slice(first.length).trim()}`;
}

/** Turn timed narration into caption cues; time is shared out by character count. */
export function buildCues(items: readonly TimedText[], options: CueOptions): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const maxChars = options.maxCharsPerLine * options.maxLines;
  const minCue = options.minCueMs ?? 900;
  for (const item of items) {
    const chunks = chunkText(item.text, maxChars);
    const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let cursor = item.start_ms;
    for (const chunk of chunks) {
      const duration = Math.max(minCue, (item.duration_ms * chunk.length) / totalChars);
      cues.push({
        index: cues.length + 1,
        start_ms: Math.round(cursor),
        end_ms: Math.round(Math.min(cursor + duration, item.start_ms + Math.max(item.duration_ms, minCue))),
        text: wrapLines(chunk, options.maxCharsPerLine),
      });
      cursor += duration;
    }
  }
  // Never overlap: a cue ends when the next one starts.
  for (let i = 0; i < cues.length - 1; i++) {
    const cue = cues[i] as CaptionCue;
    const next = cues[i + 1] as CaptionCue;
    if (cue.end_ms > next.start_ms) cue.end_ms = next.start_ms;
  }
  return cues.filter((c) => c.end_ms > c.start_ms);
}

function timestamp(ms: number, separator: "," | "."): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const rest = total % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(rest, 3)}`;
}

export function toSrt(cues: readonly CaptionCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${timestamp(c.start_ms, ",")} --> ${timestamp(c.end_ms, ",")}\n${c.text}\n`)
    .join("\n");
}

export function toVtt(cues: readonly CaptionCue[]): string {
  const body = cues.map((c) => `${timestamp(c.start_ms, ".")} --> ${timestamp(c.end_ms, ".")}\n${c.text}\n`).join("\n");
  return `WEBVTT\n\n${body}`;
}
