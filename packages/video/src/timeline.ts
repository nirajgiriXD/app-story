import type { Box, CursorPoint } from "@app-story/contracts";
import type { VideoTemplate } from "./templates";

/*
 * Pure timing maths shared by the Node side (planning) and the compositions
 * (rendering). No React, no Node APIs.
 */

export interface TimelinePlan {
  introStartMs: number;
  introEndMs: number;
  recordingStartMs: number;
  recordingEndMs: number;
  outroStartMs: number;
  outroEndMs: number;
  totalMs: number;
}

/**
 * intro card → (crossfade) → recording → (crossfade) → outro card.
 * Cards stretch to fit their narration.
 */
export function planTimeline(input: { template: VideoTemplate; recordingMs: number; introAudioMs?: number; outroAudioMs?: number }): TimelinePlan {
  const t = input.template.transitionMs;
  const introMs = Math.max(input.template.introMs, (input.introAudioMs ?? 0) + 600 + t);
  const outroMs = Math.max(input.template.outroMs, (input.outroAudioMs ?? 0) + 900 + t);
  const recordingStartMs = introMs - t;
  const recordingEndMs = recordingStartMs + input.recordingMs;
  const outroStartMs = recordingEndMs - t;
  const outroEndMs = outroStartMs + outroMs;
  return { introStartMs: 0, introEndMs: introMs, recordingStartMs, recordingEndMs, outroStartMs, outroEndMs, totalMs: outroEndMs };
}

export interface FocusWindow {
  startMs: number;
  endMs: number;
  box: Box;
}

/**
 * Merge focus windows that are close together so the camera pans instead of zooming out
 * and in. A page change (`cuts`, recording ms) always ends a group: the new page is first
 * seen whole, like an editor would cut to a wide shot.
 */
export function mergeFocusWindows(windows: readonly FocusWindow[], gapMs = 1200, cuts: readonly number[] = []): FocusWindow[][] {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const groups: FocusWindow[][] = [];
  for (const w of sorted) {
    const group = groups[groups.length - 1];
    const last = group?.[group.length - 1];
    const cut = last ? cuts.some((c) => c > last.startMs && c <= w.startMs) : false;
    if (group && last && !cut && w.startMs - last.endMs <= gapMs) group.push(w);
    else groups.push([w]);
  }
  return groups;
}

export interface Camera {
  scale: number;
  /** Focus point in viewport px. */
  x: number;
  y: number;
  /** The area being shown and how far the camera is on it (0-1), for the spotlight. */
  focus?: { box: Box; amount: number };
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Room around a framed area: it fills at most this share of the view. */
const FRAME_FILL = 0.8;
/** How long the camera takes to move from one area to the next: longer for a longer move. */
const panMs = (distance: number) => Math.min(1400, Math.max(600, 500 + distance * 0.5));
/** The camera starts moving a little before the step does, like an operator anticipating it. */
const PAN_LEAD_MS = 200;
/** A held shot slowly pushes in by this much, so a long hold never looks frozen. */
const DRIFT = 0.04;

/** The shot that frames `box`: centred on it, as close as fits with room around it, never past `maxScale`. */
export function frameBox(box: Box, viewport: { width: number; height: number }, maxScale: number): Camera {
  const fit = Math.min((viewport.width * FRAME_FILL) / Math.max(1, box.width), (viewport.height * FRAME_FILL) / Math.max(1, box.height));
  return { scale: Math.max(1, Math.min(maxScale, fit)), x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Camera (zoom + focus) at recording time `t`, like an editor's camera moves: it pushes in
 * on the area of a group of steps (their form, card or result), holds steady while they
 * happen (drifting in slowly), glides from area to area, and pulls back out between groups.
 * Ramps are shortened when groups are close, so moves never overlap or jump.
 */
export function cameraAt(
  t: number,
  groups: readonly FocusWindow[][],
  viewport: { width: number; height: number },
  zoom: { scale: number; rampMs: number },
): Camera {
  const wide = { scale: 1, x: viewport.width / 2, y: viewport.height / 2 };
  for (const [g, group] of groups.entries()) {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) continue;
    const prevEnd = groups[g - 1]?.[(groups[g - 1]?.length ?? 1) - 1]?.endMs;
    const nextStart = groups[g + 1]?.[0]?.startMs;
    const rampIn = Math.max(1, Math.min(zoom.rampMs, prevEnd === undefined ? zoom.rampMs : (first.startMs - prevEnd) / 2));
    const rampOut = Math.max(1, Math.min(zoom.rampMs, nextStart === undefined ? zoom.rampMs : (nextStart - last.endMs) / 2));
    if (t < first.startMs - rampIn || t > last.endMs + rampOut) continue;

    const amount = t < first.startMs ? smooth((t - (first.startMs - rampIn)) / rampIn) : t > last.endMs ? smooth((last.endMs + rampOut - t) / rampOut) : 1;
    let shot = frameBox(first.box, viewport, zoom.scale);
    let box = first.box;
    for (const w of group.slice(1)) {
      const next = frameBox(w.box, viewport, zoom.scale);
      const k = smooth((t - (w.startMs - PAN_LEAD_MS)) / panMs(Math.hypot(next.x - shot.x, next.y - shot.y)));
      if (k <= 0) break;
      shot = { scale: shot.scale + (next.scale - shot.scale) * k, x: shot.x + (next.x - shot.x) * k, y: shot.y + (next.y - shot.y) * k };
      const mix = (a: number, b: number) => a + (b - a) * k;
      box = { x: mix(box.x, w.box.x), y: mix(box.y, w.box.y), width: mix(box.width, w.box.width), height: mix(box.height, w.box.height) };
    }
    const held = Math.min(1, Math.max(0, (t - first.startMs) / Math.max(1, last.endMs - first.startMs)));
    const scale = shot.scale * (1 + DRIFT * held);
    return {
      scale: 1 + (scale - 1) * amount,
      x: wide.x + (shot.x - wide.x) * amount,
      y: wide.y + (shot.y - wide.y) * amount,
      focus: { box, amount },
    };
  }
  return wide;
}

/** CSS transform (origin top-left) that shows the camera's view without leaving the frame. */
export function cameraTransform(camera: Camera, viewport: { width: number; height: number }): { scale: number; tx: number; ty: number } {
  const viewW = viewport.width / camera.scale;
  const viewH = viewport.height / camera.scale;
  const left = clamp(camera.x - viewW / 2, 0, viewport.width - viewW);
  const top = clamp(camera.y - viewH / 2, 0, viewport.height - viewH);
  return { scale: camera.scale, tx: -left, ty: -top };
}

/** Cursor position at recording time `t`, plus how long ago the last click happened. */
export function cursorAt(t: number, points: readonly CursorPoint[]): { x: number; y: number; sinceClickMs: number | null } | null {
  if (points.length === 0) return null;
  let prev = points[0] as CursorPoint;
  let lastClick: number | null = null;
  for (const p of points) {
    if (p.t > t) {
      const k = (t - prev.t) / Math.max(1, p.t - prev.t);
      return { x: prev.x + (p.x - prev.x) * k, y: prev.y + (p.y - prev.y) * k, sinceClickMs: lastClick === null ? null : t - lastClick };
    }
    if (p.click) lastClick = p.t;
    prev = p;
  }
  return { x: prev.x, y: prev.y, sinceClickMs: lastClick === null ? null : t - lastClick };
}

/** The pointer hides after this long without moving, as screen-recording editors do. */
export const CURSOR_IDLE_MS = 2500;
export const CURSOR_FADE_MS = 400;

/**
 * How visible the pointer is at `t` (0-1): shown while it moves and for a while after,
 * faded out when it rests, and faded back in just before it moves again.
 */
export function cursorPresence(t: number, points: readonly CursorPoint[]): number {
  let lastActive = Number.NEGATIVE_INFINITY;
  let nextActive = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as CursorPoint;
    const b = points[i] as CursorPoint;
    const moving = Math.hypot(b.x - a.x, b.y - a.y) > 0.5 || b.click;
    if (!moving) continue;
    const from = b.click && Math.hypot(b.x - a.x, b.y - a.y) <= 0.5 ? b.t : a.t;
    if (from <= t && b.t >= t) return 1;
    if (b.t < t) lastActive = Math.max(lastActive, b.t);
    else nextActive = Math.min(nextActive, from);
  }
  const resting = smooth((t - lastActive - CURSOR_IDLE_MS) / CURSOR_FADE_MS);
  const arriving = smooth(1 - (nextActive - t) / CURSOR_FADE_MS);
  return Math.max(1 - resting, arriving);
}

/** Latest entry at or before `t`. */
export function latestAt<T extends { atMs: number }>(t: number, items: readonly T[]): T | undefined {
  let found: T | undefined;
  for (const item of items) if (item.atMs <= t) found = item;
  return found;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}
