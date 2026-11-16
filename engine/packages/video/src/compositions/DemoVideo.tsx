import type React from "react";
import type { RenderProps } from "../props";
import { RecordingScene } from "./RecordingScene";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "./runtime";
import { TitleCard } from "./TitleCard";
import { backdrop, fontStack, px } from "./theme";

/** The picture of the whole video. The sound (voice and music) is mixed by FFmpeg, see audio.ts. */
export const DemoVideo: React.FC<RenderProps> = (p) => {
  const { fps } = useVideoConfig();
  const f = (ms: number) => Math.max(0, Math.round((ms / 1000) * fps));

  return (
    <AbsoluteFill style={{ background: backdrop(p) }}>
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
  const edge = p.template.frame === "window" ? px(p, 22) : px(p, 48);
  return (
    <AbsoluteFill
      style={{
        justifyContent: p.captions.position === "top" ? "flex-start" : "flex-end",
        alignItems: "center",
        padding: `${edge}px ${px(p, 80)}px`,
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
