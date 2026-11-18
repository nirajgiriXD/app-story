import type { AudioClip, Box, CursorPoint, PlacedClip, ProductConfig, Step, StepResult, WordTiming } from "@app-story/contracts";
import { RESOLUTIONS } from "@app-story/contracts";
import type { TimeMap } from "./edit";
import type { RenderProps, SoundEffect } from "./props";
import type { VideoTemplate } from "./templates";
import { keyLabels } from "./keys";
import { DEFAULT_CTA, shownUrl } from "./labels";
import { BRAND_FONT_FAMILY } from "./fonts";
import { placeCaptions } from "./compositions/layout";
import { posterTime } from "./poster";
import { INTRO_VOICE_AT_MS, planTimeline, type FocusWindow, type TimelinePlan } from "./timeline";

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
  /** When each word is spoken, from the clip's start. */
  words?: WordTiming[];
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
  /** Open with the full-screen intro (`--intro`); otherwise the intro line is spoken over the app. */
  introSequence?: boolean;
}): { plan: TimelinePlan; placements: NarrationPlacement[] } {
  const plan = planTimeline({
    template: input.template,
    recordingMs: input.recordingMs,
    introAudioMs: input.intro?.duration_ms,
    outroAudioMs: input.outro?.duration_ms,
    intro: input.introSequence,
  });
  const placements: NarrationPlacement[] = [];
  if (input.intro) {
    placements.push({
      src: input.toSrc(input.intro.path),
      text: input.intro.text,
      startMs: INTRO_VOICE_AT_MS,
      durationMs: input.intro.duration_ms,
      words: input.intro.words,
    });
  }
  for (const clip of input.segments) {
    placements.push({
      src: input.toSrc(clip.path),
      text: clip.text,
      startMs: plan.recordingStartMs + clip.start_ms,
      durationMs: clip.duration_ms,
      words: clip.words,
    });
  }
  if (input.outro) {
    placements.push({
      src: input.toSrc(input.outro.path),
      text: input.outro.text,
      startMs: plan.outroStartMs + input.template.transitionMs + 300,
      durationMs: input.outro.duration_ms,
      words: input.outro.words,
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
  /** Length of the recording as shown (after the edit). */
  recordingMs: number;
  /** The edit: which moment of the take is shown when. Every other time here is already edited. */
  timeMap?: TimeMap;
  workflowSteps: Step[];
  results: StepResult[];
  cursor: CursorPoint[];
  startUrl: string;
  /** Address changes as they happened; without them, each step's address is used from its end. */
  navigations?: { t: number; url: string }[];
  /** Scrolls on camera (none in takes recorded before they were noted). */
  scrolls?: { start_ms: number; end_ms: number }[];
  placements: NarrationPlacement[];
  cues: { start_ms: number; end_ms: number; text: string }[];
  logoSrc?: string;
  /** The brand's font file (`font:` in the product file). */
  fontSrc?: string;
  /** The brand's backdrop image (`background:` in the product file). */
  backgroundSrc?: string;
  musicSrc?: string;
  heroSrc?: string;
  /** The cards' words in another language (default: English, and the template's badge). */
  labels?: RenderProps["labels"];
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
  const scrolls = input.scrolls ?? [];
  // The browser bar shows the public website's address, not the staging copy's.
  const website = config.product.website;
  const shown = urls.map((u) => ({ ...u, url: shownUrl(u.url, config.product.base_url, website) }));

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
    // A step that scrolls its element into view is framed once the page is still: its area was measured there.
    const scrolled = scrolls.filter((s) => s.start_ms >= result.started_ms && s.start_ms <= result.ended_ms).at(-1);
    const start = scrolled ? scrolled.end_ms : result.started_ms;
    focus.push({ startMs: start, endMs: Math.max(hold, start + 600), box });
  }

  // A card already shows its title and subtitle: a caption that repeats them only clutters it.
  const onCard = new Set([input.title, input.subtitle].filter(Boolean).map((t) => sameText(t as string)));
  const onIntro = (p: NarrationPlacement) => plan.introEndMs > 0 && p.startMs < plan.recordingStartMs;
  const repeated = input.placements.filter((p) => onCard.has(sameText(p.text)) && (onIntro(p) || p.startMs >= plan.outroStartMs));
  const cues = input.cues.filter((c) => !repeated.some((p) => c.start_ms >= p.startMs - 1 && c.start_ms < p.startMs + p.durationMs));

  return placeCaptions({
    width,
    height,
    fps: config.demo.fps,
    durationMs: plan.totalMs,
    posterMs: posterTime(plan, template),
    // The chapter chip only with `--chapters` (and a template that has one); the MP4 lists the chapters either way.
    template: config.demo.chapters ? template : { ...template, sectionStyle: "none" },
    brand: {
      productName: config.product.name,
      logo: input.logoSrc ?? null,
      primary: config.branding.primary_color,
      accent: config.branding.accent_color,
      font: input.fontSrc ? BRAND_FONT_FAMILY : config.branding.font,
      fontFile: input.fontSrc ?? null,
      host: new URL(website ?? config.product.base_url).host,
      cta: config.branding.cta ?? DEFAULT_CTA,
      background: input.backgroundSrc ? { image: input.backgroundSrc } : config.branding.background_color ? { color: config.branding.background_color } : null,
    },
    title: input.title,
    subtitle: input.subtitle ?? null,
    hero: input.heroSrc ?? null,
    intro: { startMs: plan.introStartMs, endMs: plan.introEndMs },
    outro: { startMs: plan.outroStartMs, endMs: plan.outroEndMs },
    recording: {
      src: input.recordingSrc,
      startMs: plan.recordingStartMs,
      holdMs: plan.recordingHoldMs,
      durationMs: input.recordingMs,
      timeMap: input.timeMap,
      viewport: config.browser.viewport,
    },
    sections,
    focus,
    // A scroll ends a shot like a page change: the camera pulls back before the page moves.
    cuts: [...cuts, ...scrolls.map((s) => s.start_ms)].sort((a, b) => a - b),
    scrolls: scrolls.map((s) => ({ startMs: s.start_ms, endMs: s.end_ms })),
    cursor: input.cursor,
    urls: shown,
    audio: input.placements.map((p) => ({ src: p.src, startMs: p.startMs, durationMs: p.durationMs })),
    captions: {
      enabled: config.captions.enabled && config.captions.burn_in,
      fontSize: config.captions.font_size,
      position: config.captions.position,
      cues: cues.map((c) => ({ startMs: c.start_ms, endMs: c.end_ms, text: c.text })),
    },
    music: input.musicSrc ? { src: input.musicSrc, volume: config.branding.music_volume } : null,
    sfx: template.sounds ? soundEffects(passed, input.cursor, plan, template.transitionMs) : [],
    labels: input.labels,
    // Keycaps unless `--no-keys`.
    keys: !config.demo.keys
      ? []
      : passed.flatMap((r) => {
          const key = r.action === "press" ? byId.get(r.step_id)?.key : undefined;
          return key ? [{ atMs: Math.max(0, r.started_ms), labels: keyLabels(key) }] : [];
        }),
    menus: passed.flatMap((r) =>
      r.menu && r.box ? [{ openMs: r.menu.opened_ms, closeMs: r.menu.closed_ms, field: r.box, options: r.menu.options, from: r.menu.from, to: r.menu.to }] : [],
    ),
  });
}

function sameText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Where the sound effects go (global time): a tick on every click, taps while a value is
 * typed, a whoosh into and out of the app, and a chime when the final outcome is confirmed.
 */
export function soundEffects(results: readonly StepResult[], cursor: readonly CursorPoint[], plan: TimelinePlan, transitionMs: number): SoundEffect[] {
  const at = (ms: number) => plan.recordingStartMs + ms;
  const clicks = cursor.filter((c) => c.click).map((c) => c.t);
  // A whoosh into the app only after an intro: a video that opens on the app starts quietly.
  const effects: SoundEffect[] = plan.introEndMs > 0 ? [{ kind: "whoosh", atMs: plan.recordingStartMs - transitionMs * 0.4 }] : [];
  for (const t of clicks) effects.push({ kind: "click", atMs: at(t) });
  for (const r of results) {
    if (r.action !== "fill") continue;
    // Typing starts once the field is clicked and lasts until the step ends.
    const click = clicks.find((t) => t >= r.started_ms && t <= r.ended_ms);
    const from = (click ?? r.started_ms) + 80;
    if (r.ended_ms - from > 120) effects.push({ kind: "typing", atMs: at(from), durationMs: r.ended_ms - from - 40 });
  }
  const outcome = [...results].reverse().find((r) => r.action === "assert" && r.verified && r.result_box);
  if (outcome) effects.push({ kind: "chime", atMs: at(outcome.started_ms + 150) });
  effects.push({ kind: "whoosh", atMs: plan.outroStartMs });
  return effects.sort((a, b) => a.atMs - b.atMs);
}
