/*
 * The editor's pass over the take: stretches where nothing happens (no voice, no pointer
 * moving, no typing, no page reacting to a click) are fast-forwarded, the way an editor
 * speeds through a loading spinner. A short stretch at each end of them plays at normal
 * speed, so the change of pace is never abrupt. Everything else plays as recorded.
 *
 * The result is a time map: pairs of [output ms, take ms], both increasing, joined by
 * straight lines. Pure maths, shared by the Node side and the render page.
 */

import type { CursorPoint, StepResult } from "@app-story/contracts";

/** [output ms, take ms]. */
export type TimeMap = [number, number][];

export interface EditOptions {
  /** Idle stretches shorter than this play as recorded. */
  minIdleMs: number;
  /** Normal-speed time kept at each end of an idle stretch. */
  keepMs: number;
  /** How much faster the middle of an idle stretch plays. */
  speed: number;
}

export const EDIT_DEFAULTS: EditOptions = { minIdleMs: 1500, keepMs: 400, speed: 4 };

/** Plan the edit of a take `durationMs` long, given the stretches where something happens. */
export function planEdit(durationMs: number, active: readonly [number, number][], options: EditOptions = EDIT_DEFAULTS): TimeMap {
  const busy = mergeIntervals(active.map(([a, b]) => [Math.max(0, a), Math.min(durationMs, b)] as [number, number]).filter(([a, b]) => b > a));
  const map: TimeMap = [[0, 0]];
  let out = 0;
  let at = 0;
  const playTo = (src: number, rate: number) => {
    if (src <= at) return;
    out += (src - at) / rate;
    at = src;
    map.push([out, at]);
  };
  for (const [from, to] of [...busy, [durationMs, durationMs] as [number, number]]) {
    const idle = from - at;
    if (idle >= options.minIdleMs) {
      playTo(at + options.keepMs, 1);
      playTo(from - options.keepMs, options.speed);
    }
    playTo(from, 1);
    playTo(to, 1);
  }
  return simplify(map);
}

/** Output time of take time `src`. */
export function toOutput(map: TimeMap | undefined, src: number): number {
  return lookup(map, src, 1, 0);
}

/** Take time shown at output time `out`. */
export function toSource(map: TimeMap | undefined, out: number): number {
  return lookup(map, out, 0, 1);
}

/** Length of the edited take. */
export function editedLength(map: TimeMap | undefined, durationMs: number): number {
  return toOutput(map, durationMs);
}

function lookup(map: TimeMap | undefined, value: number, from: 0 | 1, to: 0 | 1): number {
  if (!map || map.length < 2) return value;
  const first = map[0] as [number, number];
  if (value <= first[from]) return first[to] + (value - first[from]);
  for (let i = 1; i < map.length; i++) {
    const a = map[i - 1] as [number, number];
    const b = map[i] as [number, number];
    if (value <= b[from]) {
      const span = b[from] - a[from];
      return span <= 0 ? b[to] : a[to] + ((value - a[from]) / span) * (b[to] - a[to]);
    }
  }
  const last = map[map.length - 1] as [number, number];
  return last[to] + (value - last[from]);
}

function mergeIntervals(intervals: [number, number][]): [number, number][] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Drop points in the middle of a straight stretch (same speed on both sides). */
function simplify(map: TimeMap): TimeMap {
  const result: TimeMap = [];
  for (const p of map) {
    const a = result[result.length - 2];
    const b = result[result.length - 1];
    if (a && b) {
      const rateAB = (b[1] - a[1]) / Math.max(1e-9, b[0] - a[0]);
      const rateBP = (p[1] - b[1]) / Math.max(1e-9, p[0] - b[0]);
      if (Math.abs(rateAB - rateBP) < 1e-9) {
        result[result.length - 1] = p;
        continue;
      }
    }
    result.push(p);
  }
  return result;
}

interface TakeTimes<V extends { start_ms: number; duration_ms: number } = { start_ms: number; duration_ms: number }> {
  durationMs: number;
  steps: readonly StepResult[];
  cursor: readonly CursorPoint[];
  navigations?: readonly { t: number; url: string }[];
  /** Voice clips on the take (take ms). */
  voice: readonly V[];
}

/** The stretches of a take where something happens: never fast-forwarded. */
export function activeStretches(take: TakeTimes): [number, number][] {
  const active: [number, number][] = [
    [0, 300],
    // The end of the take, where the camera pulls back for the outro.
    [take.durationMs - 1800, take.durationMs],
  ];
  for (const v of take.voice) active.push([v.start_ms - 150, v.start_ms + v.duration_ms + 150]);
  for (let i = 1; i < take.cursor.length; i++) {
    const a = take.cursor[i - 1] as CursorPoint;
    const b = take.cursor[i] as CursorPoint;
    if (Math.hypot(b.x - a.x, b.y - a.y) > 0.5) active.push([a.t, b.t]);
    if (b.click) active.push([b.t - 300, b.t + 1200]); // the page reacting to the click
  }
  for (const s of take.steps) {
    if (s.action === "fill" || s.action === "scroll" || s.action === "press") active.push([s.started_ms, s.ended_ms]);
  }
  for (const n of take.navigations ?? []) active.push([n.t - 200, n.t + 700]); // the new page appearing
  return active;
}

/** The take's times moved onto the edited timeline. */
export function editTimes<V extends { start_ms: number; duration_ms: number }>(
  map: TimeMap,
  take: TakeTimes<V>,
): { durationMs: number; steps: StepResult[]; cursor: CursorPoint[]; navigations?: { t: number; url: string }[]; voice: V[] } {
  const at = (ms: number) => Math.round(toOutput(map, ms));
  return {
    durationMs: at(take.durationMs),
    steps: take.steps.map((s) => ({
      ...s,
      started_ms: at(s.started_ms),
      ended_ms: at(s.ended_ms),
      ...(s.menu ? { menu: { ...s.menu, opened_ms: at(s.menu.opened_ms), closed_ms: at(s.menu.closed_ms) } } : {}),
    })),
    cursor: take.cursor.map((p) => ({ ...p, t: at(p.t) })),
    navigations: take.navigations?.map((n) => ({ ...n, t: at(n.t) })),
    voice: take.voice.map((v) => ({ ...v, start_ms: at(v.start_ms) })),
  };
}

/** The take's frame shown at output frame `frame` (both counted from the recording's start). */
export function sourceFrame(map: TimeMap | undefined, frame: number, fps: number): number {
  if (!map) return Math.max(0, Math.round(frame));
  return Math.max(0, Math.round((toSource(map, (frame * 1000) / fps) * fps) / 1000));
}
