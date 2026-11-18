import type { Box, CursorPoint } from "@app-story/contracts";
import type { TimeMap } from "./edit";
import type { VideoTemplate } from "./templates";

/** Everything the render page needs to draw the video. JSON-serialisable; all times are global ms unless noted. Every `src` is relative to the job folder. */
export interface RenderProps {
  [key: string]: unknown;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  template: VideoTemplate;
  brand: {
    productName: string;
    logo: string | null;
    primary: string;
    accent: string;
    font: string;
    /** The address viewers are sent to: the product's public website, else the app's own host. */
    host: string;
    /** The end card's call to action in the first language; `{host}` is `host`. */
    cta?: string;
  };
  title: string;
  subtitle: string | null;
  /** A still of the app's first screen, shown on the intro card. */
  hero: string | null;
  intro: { startMs: number; endMs: number };
  outro: { startMs: number; endMs: number };
  recording: {
    src: string;
    /** Global time at which recording t=0 is shown. */
    startMs: number;
    /** How long the recording is shown, after the edit. */
    durationMs: number;
    /** The edit: [shown ms, take ms] pairs (see edit.ts). Without it the take plays as recorded. */
    timeMap?: TimeMap;
    viewport: { width: number; height: number };
  };
  /** Recording-relative times below. */
  sections: { title: string; atMs: number }[];
  focus: { startMs: number; endMs: number; box: Box }[];
  /** When the page changed: the camera never holds a shot across one. */
  cuts: number[];
  cursor: CursorPoint[];
  urls: { atMs: number; url: string }[];
  /** Global times. */
  audio: { src: string; startMs: number; durationMs: number }[];
  captions: { enabled: boolean; fontSize: number; position: "bottom" | "top"; cues: { startMs: number; endMs: number; text: string }[] };
  music: { src: string; volume: number } | null;
  /** Sound effects (global times). */
  sfx?: SoundEffect[];
  /** Keys pressed on camera, shown as keycaps (recording-relative times). */
  keys?: { atMs: number; labels: string[] }[];
  /** The cards' own words in the video's language: the end card's call to action (`{host}` is the app's address) and the title badge. */
  labels?: { cta: string; badge: string | null };
}

export interface SoundEffect {
  kind: "click" | "typing" | "whoosh" | "chime";
  atMs: number;
  /** Typing only: how long the keys are heard. */
  durationMs?: number;
}
