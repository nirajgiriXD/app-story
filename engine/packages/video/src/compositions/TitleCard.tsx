import type React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "./runtime";
import type { RenderProps } from "../props";
import { asset, backdrop, fontStack, px, textColor } from "./theme";

export const TitleCard: React.FC<{ p: RenderProps; kind: "intro" | "outro"; durationMs: number }> = ({ p, kind, durationMs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const colors = textColor(p);
  const enter = (delay: number) => spring({ frame: frame - (delay * fps) / 1000, fps, config: { damping: 200, mass: 0.8 } });
  const fadeMs = p.template.transitionMs;
  const opacity =
    kind === "intro"
      ? interpolate(ms, [durationMs - fadeMs, durationMs], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
      : interpolate(ms, [0, fadeMs], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const rise = (delay: number) => ({
    opacity: enter(delay),
    transform: `translateY(${interpolate(enter(delay), [0, 1], [px(p, 24), 0])}px)`,
  });

  return (
    <AbsoluteFill
      style={{
        background: backdrop(p),
        opacity,
        fontFamily: fontStack(p.brand.font),
        justifyContent: "center",
        padding: `0 ${px(p, 160)}px`,
      }}
    >
      {p.brand.logo ? (
        <Img src={asset(p, p.brand.logo)} style={{ height: px(p, 64), objectFit: "contain", alignSelf: "flex-start", marginBottom: px(p, 40), ...rise(0) }} />
      ) : null}
      {kind === "intro" ? (
        <>
          <div style={{ display: "flex", gap: px(p, 16), alignItems: "center", marginBottom: px(p, 20), ...rise(80) }}>
            {p.template.title.badge ? (
              <span
                style={{
                  background: p.brand.primary,
                  color: "#fff",
                  fontSize: px(p, 22),
                  fontWeight: 600,
                  padding: `${px(p, 6)}px ${px(p, 16)}px`,
                  borderRadius: 999,
                }}
              >
                {p.template.title.badge}
              </span>
            ) : null}
            <span style={{ color: p.brand.primary, fontSize: px(p, 26), fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              {p.brand.productName}
            </span>
          </div>
          <div
            style={{
              color: colors.strong,
              fontSize: px(p, p.template.title.size),
              fontWeight: p.template.title.weight,
              lineHeight: 1.08,
              letterSpacing: "-0.02em",
              maxWidth: px(p, 1400),
              ...rise(160),
            }}
          >
            {p.title}
          </div>
          {p.subtitle ? (
            <div style={{ color: colors.muted, fontSize: px(p, 32), marginTop: px(p, 28), maxWidth: px(p, 1200), lineHeight: 1.4, ...rise(320) }}>
              {p.subtitle}
            </div>
          ) : null}
          <div style={{ width: px(p, 96), height: px(p, 6), borderRadius: 3, background: p.brand.primary, marginTop: px(p, 44), ...rise(420) }} />
        </>
      ) : (
        <>
          <div style={{ color: colors.strong, fontSize: px(p, 64), fontWeight: p.template.title.weight, letterSpacing: "-0.02em", ...rise(80) }}>
            {p.brand.productName}
          </div>
          <div style={{ color: colors.muted, fontSize: px(p, 32), marginTop: px(p, 20), ...rise(220) }}>{p.title}</div>
          <div style={{ color: p.brand.primary, fontSize: px(p, 30), fontWeight: 600, marginTop: px(p, 40), ...rise(360) }}>{p.brand.host}</div>
        </>
      )}
    </AbsoluteFill>
  );
};
