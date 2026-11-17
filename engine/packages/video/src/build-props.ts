import type { AudioClip, Box, CursorPoint, PlacedClip, ProductConfig, Step, StepResult } from "@app-story/contracts";
import { RESOLUTIONS } from "@app-story/contracts";
import type { RenderProps } from "./props";
import type { VideoTemplate } from "./templates";
import { planTimeline, type FocusWindow, type TimelinePlan } from "./timeline";

const FOCUS_ACTIONS = new Set(["click", "fill", "select", "check", "uncheck", "hover"]);
/** The last shot ends this long before the recording does, so the camera is wide for the outro. */
const LAST_SHOT_GAP_MS = 1500;

/**
 * What a step's shot frames: an action's element with its area (form, card, dialog), or a
 * check's verified outcome with its area. Nothing for steps with nothing to show.
 */
export function shotBox(result: StepResult): Box | undefined {
  const subject = FOCUS_ACTIONS.has(result.action) ? result.box : result.result_box;
  if (!subject) return undefined;
  return result.region ? union(subject, result.region) : subject;
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export interface NarrationPlacement {
  src: string;
  text: string;
  startMs: number;
  durationMs: number;
}

/** Plan the timeline and place every narration clip on it (global time). */
export function placeNarration(input: {
  template: VideoTemplate;
  recordingMs: number;
  intro?: AudioClip;
  outro?: AudioClip;
  segments: PlacedClip[];
  /** Map an absolute clip path to the path the renderer will serve. */
  toSrc: (path: string) => string;
}): { plan: TimelinePlan; placements: NarrationPlacement[] } {
  const plan = planTimeline({
    template: input.template,
    recordingMs: input.recordingMs,
    introAudioMs: input.intro?.duration_ms,
    outroAudioMs: input.outro?.duration_ms,
  });
  const placements: NarrationPlacement[] = [];
  if (input.intro) {
    placements.push({ src: input.toSrc(input.intro.path), text: input.intro.text, startMs: 450, durationMs: input.intro.duration_ms });
  }
  for (const clip of input.segments) {
    placements.push({
      src: input.toSrc(clip.path),
      text: clip.text,
      startMs: plan.recordingStartMs + clip.start_ms,
      durationMs: clip.duration_ms,
    });
  }
  if (input.outro) {
    placements.push({
      src: input.toSrc(input.outro.path),
      text: input.outro.text,
      startMs: plan.outroStartMs + input.template.transitionMs + 300,
      durationMs: input.outro.duration_ms,
    });
  }
  return { plan, placements };
}

export interface BuildPropsInput {
  config: ProductConfig;
  template: VideoTemplate;
  plan: TimelinePlan;
  title: string;
  subtitle?: string;
  recordingSrc: string;
  recordingMs: number;
  workflowSteps: Step[];
  results: StepResult[];
  cursor: CursorPoint[];
  startUrl: string;
  /** Address changes as they happened; without them, each step's address is used from its end. */
  navigations?: { t: number; url: string }[];
  placements: NarrationPlacement[];
  cues: { start_ms: number; end_ms: number; text: string }[];
  logoSrc?: string;
  musicSrc?: string;
}

export function buildRenderProps(input: BuildPropsInput): RenderProps {
  const { config, template, plan } = input;
  const [width, height] = RESOLUTIONS[config.demo.default_resolution];
  const byId = new Map(input.workflowSteps.map((s) => [s.id, s]));

  const sections: RenderProps["sections"] = [];
  const focus: FocusWindow[] = [];
  const passed = input.results.filter((r) => r.status === "passed");

  // Address changes: exact when the recording kept them, else each step's address from its end.
  const urls: RenderProps["urls"] = [{ atMs: 0, url: input.startUrl }];
  const changes = input.navigations?.length
    ? input.navigations.map((n) => ({ atMs: Math.max(0, n.t), url: n.url }))
    : passed.flatMap((r) => (r.url_after ? [{ atMs: r.ended_ms, url: r.url_after }] : []));
  for (const change of changes) if (change.url !== urls[urls.length - 1]?.url) urls.push(change);
  const cuts = urls.slice(1).map((u) => u.atMs);

  for (const [i, result] of passed.entries()) {
    const step = byId.get(result.step_id);
    const section = step?.section;
    if (section && sections[sections.length - 1]?.title !== section) sections.push({ title: section, atMs: Math.max(0, result.started_ms) });
    const box = step?.zoom === false ? undefined : shotBox(result);
    if (!box) continue;
    // Hold the shot while the narration talks about it. A page change during the step ends it
    // just before the change, so the new page is seen whole; the last shot eases out before the outro.
    const nextStart = passed[i + 1]?.started_ms ?? input.recordingMs - LAST_SHOT_GAP_MS;
    const cut = cuts.find((c) => c > result.started_ms && c <= result.ended_ms + 50);
    const hold = cut !== undefined ? cut - 250 : Math.min(nextStart, result.ended_ms + (result.action === "assert" ? 8000 : 2500));
    focus.push({ startMs: result.started_ms, endMs: Math.max(hold, result.started_ms + 600), box });
  }

  // A card already shows its title and subtitle: a caption that repeats them only clutters it.
  const onCard = new Set([input.title, input.subtitle].filter(Boolean).map((t) => sameText(t as string)));
  const repeated = input.placements.filter((p) => onCard.has(sameText(p.text)) && (p.startMs < plan.recordingStartMs || p.startMs >= plan.outroStartMs));
  const cues = input.cues.filter((c) => !repeated.some((p) => c.start_ms >= p.startMs - 1 && c.start_ms < p.startMs + p.durationMs));

  return {
    width,
    height,
    fps: config.demo.fps,
    durationMs: plan.totalMs,
    template,
    brand: {
      productName: config.product.name,
      logo: input.logoSrc ?? null,
      primary: config.branding.primary_color,
      accent: config.branding.accent_color,
      font: config.branding.font,
      host: new URL(config.product.base_url).host,
    },
    title: input.title,
    subtitle: input.subtitle ?? null,
    intro: { startMs: plan.introStartMs, endMs: plan.introEndMs },
    outro: { startMs: plan.outroStartMs, endMs: plan.outroEndMs },
    recording: {
      src: input.recordingSrc,
      startMs: plan.recordingStartMs,
      durationMs: input.recordingMs,
      viewport: config.browser.viewport,
    },
    sections,
    focus,
    cuts,
    cursor: input.cursor,
    urls,
    audio: input.placements.map((p) => ({ src: p.src, startMs: p.startMs, durationMs: p.durationMs })),
    captions: {
      enabled: config.captions.enabled && config.captions.burn_in,
      fontSize: config.captions.font_size,
      position: config.captions.position,
      cues: cues.map((c) => ({ startMs: c.start_ms, endMs: c.end_ms, text: c.text })),
    },
    music: input.musicSrc ? { src: input.musicSrc, volume: config.branding.music_volume } : null,
  };
}

function sameText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
