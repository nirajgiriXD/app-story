import type React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "./runtime";
import type { RenderProps } from "../props";
import { HANDOVER_SPLIT } from "./handover";
import { PORTRAIT_SAFE } from "./layout";
import { asset, fontStack, px, shape, textColor } from "./theme";
import { DEFAULT_CTA } from "../labels";

/**
 * The end card: the product's name, the video's title and the call to action. The intro is
 * IntroSequence (full screen); without one, the video opens on the app.
 */
export const TitleCard: React.FC<{ p: RenderProps; durationMs: number }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const colors = textColor(p);
  // The card shares the video's backdrop, so only its text moves: it arrives after the app
  // window has gone (see handover.ts).
  const start = p.template.transitionMs * HANDOVER_SPLIT;
  const enter = (delay: number) => spring({ frame: frame - ((delay + start) * fps) / 1000, fps, config: { damping: 200, mass: 0.8 } });
  const rise = (delay: number) => ({
    opacity: enter(delay),
    transform: `translateY(${interpolate(enter(delay), [0, 1], [px(p, 24), 0])}px)`,
  });

  const form = shape(p);
  const cta = (p.labels?.cta ?? p.brand.cta ?? DEFAULT_CTA).replace("{host}", p.brand.host);
  // Portrait: the words keep clear of the platform's buttons on the right (see PORTRAIT_SAFE).
  const side = px(p, form === "wide" ? 160 : 72);
  const right = form === "tall" ? px(p, PORTRAIT_SAFE.right) : side;
  const sides = right === side ? `${side}px` : `${right}px 0 ${side}px`;
  return (
    <AbsoluteFill style={{ fontFamily: fontStack(p.brand.font), justifyContent: "center", padding: `0 ${sides}` }}>
      {p.brand.logo ? (
        <Img src={asset(p, p.brand.logo)} style={{ height: px(p, 64), objectFit: "contain", alignSelf: "flex-start", marginBottom: px(p, 40), ...rise(0) }} />
      ) : null}
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
        {cta} →
      </div>
    </AbsoluteFill>
  );
};
