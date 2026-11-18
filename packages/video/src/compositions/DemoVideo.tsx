import type React from "react";
import type { RenderProps } from "../props";
import { captionEdge, layout } from "./layout";
import { RecordingScene } from "./RecordingScene";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "./runtime";
import { TitleCard } from "./TitleCard";
import { backdrop, fontStack, px, shape } from "./theme";

/** The picture of the whole video. The sound (voice and music) is mixed by FFmpeg, see audio.ts. */
export const DemoVideo: React.FC<RenderProps> = (p) => {
  const { fps } = useVideoConfig();
  const f = (ms: number) => Math.max(0, Math.round((ms / 1000) * fps));

  return (
    <AbsoluteFill style={{ background: backdrop(p) }}>
      <Grain />
      <Sequence from={f(p.recording.startMs)} durationInFrames={Math.max(1, f(p.recording.durationMs))} name="Recording">
        <RecordingScene p={p} />
      </Sequence>
      <Sequence from={0} durationInFrames={Math.max(1, f(p.intro.endMs))} name="Intro">
        <TitleCard p={p} kind="intro" durationMs={p.intro.endMs} />
      </Sequence>
      <Sequence from={f(p.outro.startMs)} durationInFrames={Math.max(1, f(p.outro.endMs - p.outro.startMs))} name="Outro">
        <TitleCard p={p} kind="outro" durationMs={p.outro.endMs - p.outro.startMs} />
      </Sequence>
      {p.captions.enabled ? <Captions p={p} /> : null}
    </AbsoluteFill>
  );
};

/**
 * Fine, still film grain over the backdrop. Smooth colour gradients turn into visible bands
 * once a video is compressed to 8 bits; a little noise hides them.
 */
const GRAIN = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0.9 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>',
)}")`;

const Grain: React.FC = () => <AbsoluteFill style={{ backgroundImage: GRAIN, opacity: 0.05, mixBlendMode: "overlay" }} />;

const Captions: React.FC<{ p: RenderProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const cue = p.captions.cues.find((c) => ms >= c.startMs && ms < c.endMs);
  if (!cue) return null;
  const fade = Math.min(
    interpolate(ms, [cue.startMs, cue.startMs + 120], [0, 1], { extrapolateRight: "clamp" }),
    interpolate(ms, [cue.endMs - 120, cue.endMs], [1, 0], { extrapolateLeft: "clamp" }),
  );
  const size = px(p, p.captions.fontSize);
  const bar = p.template.caption.style === "bar";
  const edge = captionEdge(p);
  // A caption that would cover what is being shown sits at the top (see placeCaptions).
  const top = (cue.position ?? p.captions.position) === "top";
  // Portrait and square: right under the app window, not at the far bottom of a tall frame.
  const L = shape(p) === "wide" || top ? undefined : layout(p);
  const under = L ? L.y + L.bar + p.recording.viewport.height * L.scale + px(p, 36) : undefined;
  return (
    <AbsoluteFill
      style={{
        justifyContent: under !== undefined || top ? "flex-start" : "flex-end",
        alignItems: "center",
        padding: under !== undefined ? `${under}px ${px(p, 48)}px 0` : `${edge}px ${px(p, 80)}px`,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          opacity: fade,
          fontFamily: fontStack(p.brand.font),
          fontSize: size,
          fontWeight: 500,
          lineHeight: 1.3,
          color: "#fff",
          textAlign: "center",
          whiteSpace: "pre-line",
          background: "rgba(15, 23, 42, 0.84)",
          padding: `${size * 0.32}px ${size * 0.7}px`,
          borderRadius: bar ? 0 : size * 0.45,
          width: bar ? "100%" : undefined,
          maxWidth: bar ? undefined : px(p, 1500),
        }}
      >
        {cue.text}
      </div>
    </AbsoluteFill>
  );
};
