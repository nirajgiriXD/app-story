import type { RenderProps } from "./props";

/*
 * The edit as an OpenTimelineIO timeline (.otio, JSON), so a person can open it in an
 * editor such as DaVinci Resolve and keep working on it: the take's pieces on a video track
 * (fast-forwarded stretches become plain cuts, which editors handle everywhere), the voice
 * clips on an audio track at their places, and a marker for each chapter.
 */

type Json = Record<string, unknown>;

const time = (ms: number, fps: number): Json => ({ OTIO_SCHEMA: "RationalTime.1", rate: fps, value: Math.round((ms * fps) / 1000) });
const range = (startMs: number, durationMs: number, fps: number): Json => ({
  OTIO_SCHEMA: "TimeRange.1",
  start_time: time(startMs, fps),
  duration: time(durationMs, fps),
});
const gap = (durationMs: number, fps: number): Json => ({
  OTIO_SCHEMA: "Gap.1",
  name: "",
  source_range: range(0, durationMs, fps),
  effects: [],
  markers: [],
  enabled: true,
  metadata: {},
});
const clip = (name: string, file: string, startMs: number, durationMs: number, fps: number): Json => ({
  OTIO_SCHEMA: "Clip.2",
  name,
  source_range: range(startMs, durationMs, fps),
  media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", name: "", target_url: file, available_range: null, metadata: {} } },
  active_media_reference_key: "DEFAULT_MEDIA",
  effects: [],
  markers: [],
  enabled: true,
  metadata: {},
});
const track = (name: string, kind: "Video" | "Audio", children: Json[], markers: Json[] = []): Json => ({
  OTIO_SCHEMA: "Track.1",
  name,
  kind,
  children,
  effects: [],
  markers,
  enabled: true,
  source_range: null,
  metadata: {},
});

/** The timeline of the video in `props`. `fileOf` turns a props `src` into the path the timeline points at. */
export function toOtio(props: RenderProps, fileOf: (src: string) => string): string {
  const fps = props.fps;
  const recording = props.recording;
  const video: Json[] = [];
  if (recording.startMs > 0) video.push(gap(recording.startMs, fps));
  // The edit's straight stretches: as recorded, or (fast-forwarded) cut down to their middle.
  const map = recording.timeMap ?? [
    [0, 0],
    [recording.durationMs, recording.durationMs],
  ];
  for (let i = 1; i < map.length; i++) {
    const [o0, s0] = map[i - 1] as [number, number];
    const [o1, s1] = map[i] as [number, number];
    const shown = o1 - o0;
    if (shown <= 0) continue;
    const skipped = s1 - s0 - shown;
    video.push(clip(skipped > 1 ? "Take (shortened)" : "Take", fileOf(recording.src), s0 + Math.max(0, skipped) / 2, shown, fps));
  }
  const markers = props.sections.map((s) => ({
    OTIO_SCHEMA: "Marker.2",
    name: s.title,
    marked_range: range(recording.startMs + s.atMs, 0, fps),
    color: "PURPLE",
    comment: "",
    metadata: {},
  }));

  const voice: Json[] = [];
  let at = 0;
  for (const a of [...props.audio].sort((x, y) => x.startMs - y.startMs)) {
    if (a.startMs > at) voice.push(gap(a.startMs - at, fps));
    const start = Math.max(a.startMs, at);
    voice.push(clip("Voice", fileOf(a.src), start - a.startMs, a.durationMs - (start - a.startMs), fps));
    at = a.startMs + a.durationMs;
  }

  const timeline = {
    OTIO_SCHEMA: "Timeline.1",
    name: props.title,
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      children: [track("App", "Video", video, markers), track("Voice", "Audio", voice)],
      effects: [],
      markers: [],
      enabled: true,
      source_range: null,
      metadata: {},
    },
    metadata: { app_story: { duration_ms: props.durationMs, intro_ms: props.intro.endMs, outro_start_ms: props.outro.startMs } },
  };
  return `${JSON.stringify(timeline, null, 2)}\n`;
}
