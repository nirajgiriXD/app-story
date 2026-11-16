import type { Box, CursorPoint } from "@app-story/contracts";
import type { VideoTemplate } from "./templates";

/*
 * Pure timing maths shared by the Node side (planning) and the Remotion composition
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
export function planTimeline(input: {
  template: VideoTemplate;
  recordingMs: number;
  introAudioMs?: number;
  outroAudioMs?: number;
}): TimelinePlan {
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

/** Merge focus windows that are close together so the camera pans instead of zooming out and in. */
export function mergeFocusWindows(windows: readonly FocusWindow[], gapMs = 1200): FocusWindow[][] {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const groups: FocusWindow[][] = [];
  for (const w of sorted) {
    const group = groups[groups.length - 1];
    const last = group?.[group.length - 1];
    if (group && last && w.startMs - last.endMs <= gapMs) group.push(w);
    else groups.push([w]);
  }
  return groups;
}

export interface Camera {
  scale: number;
  /** Focus point in viewport px. */
  x: number;
  y: number;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Camera (zoom + focus) at recording time `t`. */
export function cameraAt(
  t: number,
  groups: readonly FocusWindow[][],
  viewport: { width: number; height: number },
  zoom: { scale: number; rampMs: number },
): Camera {
  const center = { scale: 1, x: viewport.width / 2, y: viewport.height / 2 };
  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) continue;
    const start = first.startMs - zoom.rampMs;
    const end = last.endMs + zoom.rampMs;
    if (t < start || t > end) continue;

    const amount = t < first.startMs ? smooth((t - start) / zoom.rampMs) : t > last.endMs ? smooth((end - t) / zoom.rampMs) : 1;
    // Pan between consecutive focus boxes within the group.
    let focus = centerOf(first.box);
    for (let i = 0; i < group.length; i++) {
      const w = group[i] as FocusWindow;
      const next = group[i + 1];
      if (t >= w.startMs) focus = centerOf(w.box);
      if (next && t > w.endMs && t < next.startMs) {
        const k = smooth((t - w.endMs) / Math.max(1, next.startMs - w.endMs));
        const a = centerOf(w.box);
        const b = centerOf(next.box);
        focus = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
    }
    // Do not zoom so far that a large element no longer fits.
    const fit = Math.min(viewport.width / (first.box.width * 1.6), viewport.height / (first.box.height * 1.6));
    const target = Math.max(1, Math.min(zoom.scale, fit));
    const scale = 1 + (target - 1) * amount;
    return {
      scale,
      x: center.x + (focus.x - center.x) * amount,
      y: center.y + (focus.y - center.y) * amount,
    };
  }
  return center;
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

/** Latest entry at or before `t`. */
export function latestAt<T extends { atMs: number }>(t: number, items: readonly T[]): T | undefined {
  let found: T | undefined;
  for (const item of items) if (item.atMs <= t) found = item;
  return found;
}

function centerOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}
