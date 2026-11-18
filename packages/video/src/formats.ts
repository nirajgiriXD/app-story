import { runFfmpeg } from "@app-story/shared";
import { placeCaptions } from "./compositions/layout";
import type { RenderProps } from "./props";

/** Extra shapes of a video, made next to the main 16:9 one. */
export type FrameFormat = "vertical" | "square";

/**
 * The same video in another shape: 9:16 for Reels, Shorts and TikTok, or 1:1 for social
 * feeds, at the main video's sharpness (1080p → 1080×1920). The app window then spans the
 * width of a narrower frame, so the camera moves in closer and the pointer is drawn larger,
 * to keep the product readable on a phone.
 */
export function reshapeProps(props: RenderProps, format: FrameFormat): RenderProps {
  const short = Math.min(props.width, props.height);
  const [width, height] = format === "vertical" ? [short, Math.round((short * 16) / 9 / 2) * 2] : [short, short];
  const t = props.template;
  // Captions are placed again for the new shape (a portrait frame keeps them under the window).
  const cues = props.captions.cues.map(({ position: _position, ...cue }) => cue);
  return placeCaptions({
    ...props,
    width,
    height,
    captions: { ...props.captions, cues },
    template: {
      ...t,
      zoom: { ...t.zoom, scale: t.zoom.enabled ? t.zoom.scale * 1.3 : t.zoom.scale },
      cursor: { ...t.cursor, size: Math.round(t.cursor.size * 1.4) },
    },
  });
}

/** The longest a GIF plays: a longer recording is sped up to fit, so the whole flow is in it. */
const GIF_MAX_SECONDS = 30;

/**
 * A silent, looping GIF of the app part of a finished video (no title cards), small enough
 * for a README or a docs page: 720 px wide, 12 frames a second, its own colour palette.
 * A recording longer than 30 seconds is sped up to 30.
 */
export async function renderGif(video: string, outFile: string, recording: { startMs: number; durationMs: number }): Promise<void> {
  const seconds = recording.durationMs / 1000;
  const speed = Math.max(1, seconds / GIF_MAX_SECONDS);
  const filters = [
    `setpts=PTS/${speed.toFixed(4)}`,
    "fps=12",
    "scale=720:-2:flags=lanczos",
    "split[a][b]",
    "[a]palettegen=max_colors=192:stats_mode=diff[pal]",
    "[b][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  ];
  await runFfmpeg([
    "-ss",
    (recording.startMs / 1000).toFixed(3),
    "-t",
    seconds.toFixed(3),
    "-i",
    video,
    "-filter_complex",
    // The first filters run on the input; split/palette steps need labels, so join them as a graph.
    `[0:v]${filters.slice(0, 3).join(",")},${filters[3]};${filters[4]};${filters[5]}`,
    "-loop",
    "0",
    outFile,
  ]);
}
