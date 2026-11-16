import type { Box, CursorPoint } from "@showrun/contracts";
import type { VideoTemplate } from "./templates";

/** Everything the Remotion composition needs. JSON-serialisable; all times are global ms unless noted. */
export interface RenderProps {
  [key: string]: unknown;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  /** Folder (under the renderer's public folder) that every `src` below is relative to. */
  assetBase: string;
  template: VideoTemplate;
  brand: {
    productName: string;
    logo: string | null;
    primary: string;
    accent: string;
    font: string;
    host: string;
  };
  title: string;
  subtitle: string | null;
  intro: { startMs: number; endMs: number };
  outro: { startMs: number; endMs: number };
  recording: {
    src: string;
    /** Global time at which recording t=0 is shown. */
    startMs: number;
    durationMs: number;
    viewport: { width: number; height: number };
  };
  /** Recording-relative times below. */
  sections: { title: string; atMs: number }[];
  focus: { startMs: number; endMs: number; box: Box }[];
  cursor: CursorPoint[];
  urls: { atMs: number; url: string }[];
  /** Global times. */
  audio: { src: string; startMs: number; durationMs: number }[];
  captions: { enabled: boolean; fontSize: number; position: "bottom" | "top"; cues: { startMs: number; endMs: number; text: string }[] };
  music: { src: string; volume: number } | null;
}
