import type { WordTiming } from "@app-story/contracts";

/*
 * Narration-anchored steps. A line that covers several steps may mark the word a later step
 * should land on: "Pick a status, {{@s4}}then save it." The marker is never spoken; it is
 * taken out before the voice reads the line, and the recording then holds step s4 back until
 * the narrator reaches "then", so the click lands on the word instead of racing ahead of it.
 */

const MARKER = /\{\{\s*@([A-Za-z0-9_-]+)\s*\}\}/g;

export interface ParsedAnchors {
  /** The line without markers, as it is spoken and captioned. */
  text: string;
  /** Each anchored step and the index of the word its marker stands before (0-based, in `text`). */
  anchors: { step_id: string; word: number }[];
}

/**
 * Take the `{{@step}}` markers out of a line. Only later steps of the line's own segment can
 * be anchored (its first step starts with the line anyway); other markers are dropped, and a
 * step marked twice keeps its first marker.
 */
export function parseAnchors(text: string, stepIds: readonly string[] = []): ParsedAnchors {
  const allowed = new Set(stepIds.slice(1));
  const anchors: ParsedAnchors["anchors"] = [];
  const words: string[] = [];
  // Split around the markers: words before a marker are counted, so it points at the next word.
  let last = 0;
  const push = (chunk: string) => words.push(...chunk.split(/\s+/).filter(Boolean));
  for (const match of text.matchAll(MARKER)) {
    push(text.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
    const id = match[1] as string;
    if (allowed.has(id) && !anchors.some((a) => a.step_id === id)) anchors.push({ step_id: id, word: words.length });
  }
  push(text.slice(last));
  // A marker after the last word has nothing to land on.
  return { text: words.join(" "), anchors: anchors.filter((a) => a.word < words.length) };
}

/** The line without markers. */
export function stripAnchors(text: string): string {
  return parseAnchors(text).text;
}

/**
 * When in the clip each anchored step should happen (ms from the clip's start): when its
 * word is spoken, or, without word timing, at the same share of the clip as its word is of the line.
 */
export function anchorTimes(parsed: ParsedAnchors, durationMs: number, words?: readonly WordTiming[]): { step_id: string; at_ms: number }[] {
  const count = parsed.text.split(/\s+/).filter(Boolean).length;
  return parsed.anchors.map((a) => {
    const timed = words?.[a.word];
    const at = timed ? timed.start_ms : (a.word / Math.max(1, count)) * durationMs;
    return { step_id: a.step_id, at_ms: Math.round(Math.min(Math.max(0, at), durationMs)) };
  });
}
