import { CAMERA_MOVE_MS, type Box, type CursorPoint } from "@app-story/contracts";
import type { VideoTemplate } from "./templates";

/*
 * Pure timing maths shared by the Node side (planning) and the compositions
 * (rendering). No React, no Node APIs.
 */

export interface TimelinePlan {
  introStartMs: number;
  /** 0 without an intro: the video opens on the app. */
  introEndMs: number;
  recordingStartMs: number;
  /** Without an intro: how long the app's first screen is held, from 0, while the intro line is spoken. */
  recordingHoldMs: number;
  recordingEndMs: number;
  outroStartMs: number;
  outroEndMs: number;
  totalMs: number;
}

/** When the spoken intro starts (global ms), over the intro or over the app's first screen. */
export const INTRO_VOICE_AT_MS = 450;
/** The app's first screen stays this long after the spoken intro ends, before the recording plays. */
const HOLD_AFTER_VOICE_MS = 350;

/**
 * With an intro: intro → (handover) → recording → (handover) → outro card. The intro stretches
 * to fit its narration. Without one, the video opens on the app: its first screen is held while
 * the intro line is spoken, then the recording plays.
 */
export function planTimeline(input: {
  template: VideoTemplate;
  recordingMs: number;
  introAudioMs?: number;
  outroAudioMs?: number;
  /** Open with the full-screen intro (`--intro`). */
  intro?: boolean;
}): TimelinePlan {
  const t = input.template.transitionMs;
  const outroMs = Math.max(input.template.outroMs, (input.outroAudioMs ?? 0) + 900 + t);
  const introMs = input.intro ? Math.max(input.template.introMs, (input.introAudioMs ?? 0) + 600 + t) : 0;
  const recordingHoldMs = !input.intro && input.introAudioMs ? INTRO_VOICE_AT_MS + input.introAudioMs + HOLD_AFTER_VOICE_MS : 0;
  const recordingStartMs = input.intro ? introMs - t : recordingHoldMs;
  const recordingEndMs = recordingStartMs + input.recordingMs;
  const outroStartMs = recordingEndMs - t;
  const outroEndMs = outroStartMs + outroMs;
  return { introStartMs: 0, introEndMs: introMs, recordingStartMs, recordingHoldMs, recordingEndMs, outroStartMs, outroEndMs, totalMs: outroEndMs };
}

export interface FocusWindow {
  startMs: number;
  endMs: number;
  box: Box;
}

/**
 * Shots closer than this are joined, so the camera glides across instead of pulling back and
 * pushing in again: two full moves would not fit between them.
 */
export const SHOT_GAP_MS = 2 * CAMERA_MOVE_MS;

/**
 * Merge focus windows that are close together so the camera pans instead of zooming out
 * and in. A page change (`cuts`, recording ms) always ends a group: the new page is first
 * seen whole, like an editor would cut to a wide shot.
 */
export function mergeFocusWindows(windows: readonly FocusWindow[], gapMs = SHOT_GAP_MS, cuts: readonly number[] = []): FocusWindow[][] {
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
/** The camera starts gliding a little before the step does, like an operator anticipating it. */
const PAN_LEAD_MS = 200;
/** A held shot slowly pushes in by this much, so a long hold never looks frozen. */
const DRIFT = 0.04;

/** The shot that frames `box`: centred on it, as close as fits with room around it, never past `maxScale`. */
export function frameBox(box: Box, viewport: { width: number; height: number }, maxScale: number): Camera {
  const fit = Math.min((viewport.width * FRAME_FILL) / Math.max(1, box.width), (viewport.height * FRAME_FILL) / Math.max(1, box.height));
  return { scale: Math.max(1, Math.min(maxScale, fit)), x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * When a shot group's push-in and pull-back start. Ideally the camera arrives as the first
 * step starts and leaves as the last one ends. When a neighbouring group is too close for both
 * moves (only across a page change: closer groups are merged), each move keeps its full length
 * and they shift to meet halfway, never shortened. Nothing moves before the take starts.
 */
function shotRamps(start: number, end: number, prevEnd: number | undefined, nextStart: number | undefined): { inAt: number; outAt: number } {
  const before = prevEnd === undefined ? 0 : (prevEnd + start) / 2;
  const after = nextStart === undefined ? Number.POSITIVE_INFINITY : (end + nextStart) / 2;
  return { inAt: Math.max(start - CAMERA_MOVE_MS, before), outAt: Math.min(end, after - CAMERA_MOVE_MS) };
}

/**
 * Camera (zoom + focus) at recording time `t`, like an editor's camera moves: it pushes in
 * on the area of a group of steps (their form, card or result), holds steady while they
 * happen (drifting in slowly), glides from area to area, and pulls back out between groups.
 * Every move takes exactly CAMERA_MOVE_MS, however fast the steps (and the voice) go: a move
 * is shifted rather than hurried, and a glide never starts before the last one has ended.
 */
export function cameraAt(t: number, groups: readonly FocusWindow[][], viewport: { width: number; height: number }, zoom: { scale: number }): Camera {
  const wide = { scale: 1, x: viewport.width / 2, y: viewport.height / 2 };
  for (const [g, group] of groups.entries()) {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) continue;
    const prevEnd = groups[g - 1]?.at(-1)?.endMs;
    const nextStart = groups[g + 1]?.[0]?.startMs;
    const { inAt, outAt } = shotRamps(first.startMs, last.endMs, prevEnd, nextStart);
    if (t < inAt || t > outAt + CAMERA_MOVE_MS) continue;

    // A very short shot may start pulling back before it is fully in: it never moves faster.
    const amount = Math.min(smooth((t - inAt) / CAMERA_MOVE_MS), smooth((outAt + CAMERA_MOVE_MS - t) / CAMERA_MOVE_MS));
    const { shot, box } = glideAt(t, group, viewport, zoom.scale);
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

/**
 * Where the camera is within a shot group at `t`. Each change of area is one glide of
 * CAMERA_MOVE_MS, starting a little before its step, or when the last glide ends if that is
 * later. Areas that came due while the camera was still moving are skipped for the latest one,
 * so the camera is never more than one move behind.
 */
function glideAt(t: number, group: readonly FocusWindow[], viewport: { width: number; height: number }, maxScale: number): { shot: Camera; box: Box } {
  const first = group[0] as FocusWindow;
  let shot = frameBox(first.box, viewport, maxScale);
  let box = first.box;
  let free = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < group.length; i++) {
    const at = Math.max((group[i] as FocusWindow).startMs - PAN_LEAD_MS, free);
    while (i + 1 < group.length && (group[i + 1] as FocusWindow).startMs - PAN_LEAD_MS <= at) i++;
    const target = (group[i] as FocusWindow).box;
    if (sameBox(target, box)) continue;
    if (t < at) break;
    const next = frameBox(target, viewport, maxScale);
    const k = smooth((t - at) / CAMERA_MOVE_MS);
    const mix = (a: number, b: number) => a + (b - a) * k;
    shot = { scale: mix(shot.scale, next.scale), x: mix(shot.x, next.x), y: mix(shot.y, next.y) };
    box = { x: mix(box.x, target.x), y: mix(box.y, target.y), width: mix(box.width, target.width), height: mix(box.height, target.height) };
    free = at + CAMERA_MOVE_MS;
  }
  return { shot, box };
}

function sameBox(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
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

/** The pointer's shape at `t`: the last one the recording noted (an arrow while it travels). */
export function cursorShape(t: number, points: readonly CursorPoint[]): NonNullable<CursorPoint["shape"]> {
  let shape: NonNullable<CursorPoint["shape"]> = "arrow";
  for (const p of points) {
    if (p.t > t) break;
    if (p.shape) shape = p.shape;
  }
  return shape;
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

/** How long a drawn dropdown list takes to open, and to fade once an option is picked. */
export const MENU_OPEN_FADE_MS = 120;
export const MENU_FADE_MS = 180;

/** The dropdown list open at `t`, and how far it is shown (0-1), if any. */
export function menuAt<M extends { openMs: number; closeMs: number }>(t: number, menus: readonly M[]): { menu: M; shown: number } | undefined {
  for (const menu of menus) {
    if (t < menu.openMs || t > menu.closeMs + MENU_FADE_MS) continue;
    const opening = Math.min(1, (t - menu.openMs) / MENU_OPEN_FADE_MS);
    const closing = t <= menu.closeMs ? 1 : 1 - (t - menu.closeMs) / MENU_FADE_MS;
    return { menu, shown: smooth(Math.min(opening, closing)) };
  }
  return undefined;
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
