import type { AudioClip, CursorPoint, PlacedClip, ProductConfig, Step, StepResult } from "@showrun/contracts";
import { RESOLUTIONS } from "@showrun/contracts";
import type { RenderProps } from "./props";
import type { VideoTemplate } from "./templates";
import { planTimeline, type FocusWindow, type TimelinePlan } from "./timeline";

const FOCUS_ACTIONS = new Set(["click", "fill", "select", "check", "uncheck", "hover"]);

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
  const urls: RenderProps["urls"] = [{ atMs: 0, url: input.startUrl }];
  const passed = input.results.filter((r) => r.status === "passed");
  for (const [i, result] of passed.entries()) {
    const step = byId.get(result.step_id);
    const section = step?.section;
    if (section && sections[sections.length - 1]?.title !== section) sections.push({ title: section, atMs: Math.max(0, result.started_ms) });
    if (result.box && FOCUS_ACTIONS.has(result.action) && step?.zoom !== false) {
      // Hold the camera on the element while the narration talks about it, unless the page changed.
      const previousUrl = urls[urls.length - 1]?.url;
      const samePage = !result.url_after || result.url_after === previousUrl;
      const nextStart = passed[i + 1]?.started_ms ?? result.ended_ms + 1200;
      const hold = samePage ? Math.min(nextStart, result.ended_ms + 2500) : result.ended_ms + 200;
      focus.push({ startMs: result.started_ms, endMs: Math.max(hold, result.started_ms + 600), box: result.box });
    }
    if (result.url_after && result.url_after !== urls[urls.length - 1]?.url) urls.push({ atMs: result.ended_ms, url: result.url_after });
  }

  return {
    width,
    height,
    fps: config.demo.fps,
    durationMs: plan.totalMs,
    assetBase: "",
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
    cursor: input.cursor,
    urls,
    audio: input.placements.map((p) => ({ src: p.src, startMs: p.startMs, durationMs: p.durationMs })),
    captions: {
      enabled: config.captions.enabled && config.captions.burn_in,
      fontSize: config.captions.font_size,
      position: config.captions.position,
      cues: input.cues.map((c) => ({ startMs: c.start_ms, endMs: c.end_ms, text: c.text })),
    },
    music: input.musicSrc ? { src: input.musicSrc, volume: config.branding.music_volume } : null,
  };
}
