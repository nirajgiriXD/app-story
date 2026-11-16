import type { TemplateName } from "@app-story/contracts";

/**
 * Video templates. A template only controls presentation (framing, motion, typography,
 * captions); it never touches browser automation. To add one, add its name to
 * TEMPLATE_NAMES in the contracts package and an entry here.
 */
export interface VideoTemplate {
  name: string;
  /** `window` shows the app inside a browser-window mock on a branded backdrop; `full` fills the frame. */
  frame: "window" | "full";
  backdrop: "gradient" | "light" | "dark";
  introMs: number;
  outroMs: number;
  transitionMs: number;
  sectionStyle: "chip" | "none";
  zoom: { enabled: boolean; scale: number; rampMs: number };
  cursor: { highlight: boolean; size: number };
  caption: { style: "pill" | "bar" };
  title: { weight: number; size: number; badge?: string };
  musicVolume: number;
}

const base: Omit<VideoTemplate, "name"> = {
  frame: "window",
  backdrop: "gradient",
  introMs: 3200,
  outroMs: 3000,
  transitionMs: 500,
  sectionStyle: "chip",
  zoom: { enabled: true, scale: 1.4, rampMs: 550 },
  cursor: { highlight: true, size: 30 },
  caption: { style: "pill" },
  title: { weight: 700, size: 76 },
  musicVolume: 0.08,
};

export const TEMPLATES: Record<TemplateName, VideoTemplate> = {
  "modern-saas": { name: "modern-saas", ...base },
  minimal: {
    name: "minimal",
    ...base,
    frame: "full",
    backdrop: "light",
    sectionStyle: "none",
    zoom: { enabled: true, scale: 1.2, rampMs: 650 },
    cursor: { highlight: false, size: 26 },
    caption: { style: "bar" },
    title: { weight: 600, size: 68 },
  },
  "product-update": {
    name: "product-update",
    ...base,
    backdrop: "dark",
    title: { weight: 700, size: 80, badge: "New" },
  },
  tutorial: {
    name: "tutorial",
    ...base,
    frame: "full",
    backdrop: "light",
    introMs: 2800,
    zoom: { enabled: true, scale: 1.55, rampMs: 500 },
    cursor: { highlight: true, size: 34 },
    title: { weight: 700, size: 70 },
  },
  "feature-highlight": {
    name: "feature-highlight",
    ...base,
    introMs: 3600,
    zoom: { enabled: true, scale: 1.6, rampMs: 600 },
    title: { weight: 800, size: 92 },
  },
};

export function getTemplate(name: string): VideoTemplate {
  const template = TEMPLATES[name as TemplateName];
  if (!template) {
    throw new Error(`Unknown video template '${name}'. Available: ${Object.keys(TEMPLATES).join(", ")}.`);
  }
  return template;
}
