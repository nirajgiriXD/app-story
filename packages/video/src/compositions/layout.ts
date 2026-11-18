import type { Box } from "@app-story/contracts";
import type { RenderProps } from "../props";
import { cameraAt, cameraTransform, cursorAt, mergeFocusWindows } from "../timeline";
import { px, shape } from "./theme";

/*
 * Where things sit in the frame. Pure: used by the compositions and by the Node side,
 * which places each caption where it does not cover what the video is showing.
 */

/** Window layout in output pixels. */
export function layout(p: RenderProps) {
  const { viewport } = p.recording;
  if (p.template.frame === "full") {
    const scale = Math.min(p.width / viewport.width, p.height / viewport.height);
    return { x: (p.width - viewport.width * scale) / 2, y: (p.height - viewport.height * scale) / 2, scale, bar: 0, radius: 0 };
  }
  const bar = px(p, 46);
  if (shape(p) !== "wide") {
    // Portrait or square: the window spans the width, a little above the middle, with the
    // captions right under it (see DemoVideo's Captions).
    const scale = (p.width * 0.94) / viewport.width;
    const height = bar + viewport.height * scale;
    return { x: p.width * 0.03, y: Math.max(px(p, 120), (p.height - height) / 2 - px(p, 60)), scale, bar, radius: px(p, 18) };
  }
  // Fixed zones keep overlays off the product UI: chapter chip above, captions below.
  const top = px(p, 84);
  const bottom = p.captions.enabled ? px(p, 152) : px(p, 56);
  const maxW = p.width * 0.9;
  const maxH = p.height - top - bottom - bar;
  const scale = Math.min(maxW / viewport.width, maxH / viewport.height);
  const w = viewport.width * scale;
  return { x: (p.width - w) / 2, y: top, scale, bar, radius: px(p, 18) };
}

/** The distance from the frame's edge to a caption. */
export function captionEdge(p: RenderProps): number {
  return p.template.frame === "window" ? px(p, 22) : px(p, 48);
}

/** About how tall a two-line caption is, padding included. */
function captionHeight(p: RenderProps): number {
  return px(p, p.captions.fontSize) * 3.3;
}

/**
 * Captions over a full-screen app can hide what the narration is about (a Save button at
 * the bottom of a form). Each caption that would cover the shot's subject, or the pointer,
 * moves to the top of the frame for as long as it is shown, unless the top is in the way too.
 * A window layout keeps captions in their own zone, so nothing moves there.
 */
export function placeCaptions(p: RenderProps): RenderProps {
  if (!p.captions.enabled || p.template.frame !== "full" || shape(p) !== "wide" || p.captions.position === "top") return p;
  const L = layout(p);
  const { viewport } = p.recording;
  const groups = mergeFocusWindows(p.focus, 1200, p.cuts ?? []);
  const height = captionHeight(p);
  const edge = captionEdge(p);
  const bottomBand = { top: p.height - edge - height, bottom: p.height };
  const topBand = { top: 0, bottom: edge + height };
  // What the frame shows at global time `ms`, in output pixels: the shot's subject and the pointer.
  const subjects = (ms: number): Box[] => {
    const t = ms - p.recording.startMs;
    if (t < 0 || t > p.recording.durationMs) return [];
    const camera = p.template.zoom.enabled ? cameraAt(t, groups, viewport, p.template.zoom) : { scale: 1, x: viewport.width / 2, y: viewport.height / 2 };
    const view = cameraTransform(camera, viewport);
    const k = L.scale * view.scale;
    const toScreen = (b: Box): Box => ({ x: L.x + k * (b.x + view.tx), y: L.y + L.bar + k * (b.y + view.ty), width: k * b.width, height: k * b.height });
    const boxes: Box[] = [];
    if (camera.focus && camera.focus.amount > 0.5) boxes.push(toScreen(camera.focus.box));
    const pointer = cursorAt(t, p.cursor);
    if (pointer) boxes.push(toScreen({ x: pointer.x - 12, y: pointer.y - 12, width: 36, height: 36 }));
    return boxes;
  };
  const hits = (band: { top: number; bottom: number }, boxes: Box[]) => boxes.some((b) => b.y < band.bottom && b.y + b.height > band.top);
  const cues = p.captions.cues.map((cue) => {
    const boxes: Box[] = [];
    for (let ms = cue.startMs; ms <= cue.endMs; ms += 200) boxes.push(...subjects(ms));
    const position: "top" | "bottom" = hits(bottomBand, boxes) && !hits(topBand, boxes) ? "top" : "bottom";
    return { ...cue, position };
  });
  return { ...p, captions: { ...p.captions, cues } };
}
