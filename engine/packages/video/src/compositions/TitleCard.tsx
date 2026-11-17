import type React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "./runtime";
import type { RenderProps } from "../props";
import { HANDOVER_SPLIT, handoverOut } from "./handover";
import { asset, fontStack, px, textColor } from "./theme";

export const TitleCard: React.FC<{ p: RenderProps; kind: "intro" | "outro"; durationMs: number }> = ({ p, kind, durationMs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const colors = textColor(p);
  const fadeMs = p.template.transitionMs;
  // The card shares the video's backdrop, so only its text moves: the intro's text leaves before
  // the app window comes in, and the outro's arrives after the window has gone (see handover.ts).
  const start = kind === "outro" ? fadeMs * HANDOVER_SPLIT : 0;
  const enter = (delay: number) => spring({ frame: frame - ((delay + start) * fps) / 1000, fps, config: { damping: 200, mass: 0.8 } });
  const leave = kind === "intro" ? handoverOut(ms, durationMs, fadeMs) : 0;
  const rise = (delay: number) => ({
    opacity: enter(delay),
    transform: `translateY(${interpolate(enter(delay), [0, 1], [px(p, 24), 0])}px)`,
  });

  return (
    <AbsoluteFill
      style={{
        opacity: 1 - leave,
        transform: `translateY(${-px(p, 36) * leave}px)`,
        fontFamily: fontStack(p.brand.font),
        justifyContent: "center",
        padding: `0 ${px(p, 160)}px`,
      }}
    >
      {p.brand.logo ? (
        <Img src={asset(p, p.brand.logo)} style={{ height: px(p, 64), objectFit: "contain", alignSelf: "flex-start", marginBottom: px(p, 40), ...rise(0) }} />
      ) : null}
      {kind === "intro" && p.hero ? <Hero p={p} src={p.hero} enter={enter(260)} /> : null}
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
              maxWidth: px(p, p.hero ? 820 : 1400),
              ...rise(160),
            }}
          >
            {p.title}
          </div>
          {p.subtitle ? (
            <div
              style={{ color: colors.muted, fontSize: px(p, 32), marginTop: px(p, 28), maxWidth: px(p, p.hero ? 760 : 1200), lineHeight: 1.4, ...rise(320) }}
            >
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
          <div
            style={{
              alignSelf: "flex-start",
              marginTop: px(p, 44),
              background: p.brand.primary,
              color: "#fff",
              fontSize: px(p, 30),
              fontWeight: 600,
              padding: `${px(p, 16)}px ${px(p, 34)}px`,
              borderRadius: 999,
              boxShadow: `0 ${px(p, 14)}px ${px(p, 36)}px ${p.brand.primary}55`,
              ...rise(360),
            }}
          >
            Try it at {p.brand.host} →
          </div>
        </>
      )}
    </AbsoluteFill>
  );
};

/** The app's first screen, tilted in on the right of the intro: what the video is about, at a glance. */
const Hero: React.FC<{ p: RenderProps; src: string; enter: number }> = ({ p, src, enter }) => {
  const width = px(p, 900);
  return (
    <div
      style={{
        position: "absolute",
        left: px(p, 1000),
        top: "50%",
        width,
        height: (width * 9) / 16,
        marginTop: -(width * 9) / 32,
        borderRadius: px(p, 16),
        overflow: "hidden",
        opacity: enter,
        transform: `perspective(${px(p, 2200)}px) translateX(${px(p, 120) * (1 - enter)}px) rotateY(${-16 + 4 * enter}deg) rotateX(4deg)`,
        boxShadow: "0 40px 90px rgba(15, 23, 42, 0.30), 0 0 0 1px rgba(15, 23, 42, 0.08)",
        background: "#fff",
      }}
    >
      <Img src={asset(p, src)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left", display: "block" }} />
    </div>
  );
};
