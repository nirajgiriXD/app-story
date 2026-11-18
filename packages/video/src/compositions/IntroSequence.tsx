import type React from "react";
import type { RenderProps } from "../props";
import { handoverOut } from "./handover";
import { PORTRAIT_SAFE } from "./layout";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "./runtime";
import { asset, fontStack, px, shape } from "./theme";

/** When the first word of the title starts to come in, and how far apart the words are. */
const WORDS_AT_MS = 200;
const WORD_STAGGER_MS = 70;
/** The whole title is in within this long, however many words it has. */
const WORDS_MAX_MS = 600;

/**
 * The full-screen intro (`--intro`): the app's first screen fills the frame, slowly pushing in,
 * blurred and dimmed under the brand's colour, with a light sweep across it; the title comes
 * in word by word in the middle, over the product's name, with the subtitle under it. Then it
 * all leans in and fades as the app window arrives (see handover.ts).
 *
 * The words are always light on a dark picture, whatever the template's backdrop, so they
 * read the same over any app. Everything settles by ~1.5 s: that frame is the poster.
 */
export const IntroSequence: React.FC<{ p: RenderProps; durationMs: number }> = ({ p, durationMs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const progress = Math.min(1, ms / Math.max(1, durationMs));
  const enter = (delayMs: number) => spring({ frame: frame - (delayMs * fps) / 1000, fps, config: { damping: 200, mass: 0.7 } });
  const leave = handoverOut(ms, durationMs, p.template.transitionMs);

  const form = shape(p);
  const words = p.title.split(/\s+/).filter(Boolean);
  const stagger = words.length > 1 ? Math.min(WORD_STAGGER_MS, WORDS_MAX_MS / (words.length - 1)) : 0;
  const wordsDoneMs = WORDS_AT_MS + stagger * Math.max(0, words.length - 1);
  const badge = p.labels ? p.labels.badge : p.template.title.badge;
  const titleSize = px(p, p.template.title.size * (form === "wide" ? 1.12 : 0.9));
  const side = form === "tall" ? px(p, PORTRAIT_SAFE.right) : px(p, form === "wide" ? 200 : 96);

  const rise = (delayMs: number, distance = 28) => {
    const k = enter(delayMs);
    return { opacity: k, transform: `translateY(${interpolate(k, [0, 1], [px(p, distance), 0])}px)` };
  };

  return (
    <AbsoluteFill style={{ opacity: 1 - leave, transform: `scale(${1 + 0.06 * leave})`, fontFamily: fontStack(p.brand.font), overflow: "hidden" }}>
      <Backdrop p={p} progress={progress} />
      <Sweep p={p} ms={ms} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: `0 ${side}px` }}>
        {p.brand.logo ? <Img src={asset(p, p.brand.logo)} style={{ height: px(p, 72), objectFit: "contain", marginBottom: px(p, 36), ...rise(0) }} /> : null}
        <div style={{ display: "flex", gap: px(p, 16), alignItems: "center", marginBottom: px(p, 26), ...rise(60, 18) }}>
          {badge ? (
            <span
              style={{
                background: p.brand.primary,
                color: "#fff",
                fontSize: px(p, 22),
                fontWeight: 700,
                padding: `${px(p, 6)}px ${px(p, 16)}px`,
                borderRadius: 999,
                boxShadow: `0 0 ${px(p, 30)}px ${p.brand.primary}88`,
              }}
            >
              {badge}
            </span>
          ) : null}
          <span style={{ color: "rgba(255, 255, 255, 0.82)", fontSize: px(p, 26), fontWeight: 600, letterSpacing: "0.22em", textTransform: "uppercase" }}>
            {p.brand.productName}
          </span>
        </div>
        <div
          style={{
            color: "#fff",
            fontSize: titleSize,
            fontWeight: p.template.title.weight,
            lineHeight: 1.06,
            letterSpacing: "-0.025em",
            maxWidth: form === "wide" ? px(p, 1500) : undefined,
            textShadow: `0 ${px(p, 4)}px ${px(p, 40)}px rgba(0, 0, 0, 0.45)`,
          }}
        >
          {words.map((word, i) => {
            const k = enter(WORDS_AT_MS + stagger * i);
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the words never reorder
                key={i}
                style={{
                  display: "inline-block",
                  marginRight: i < words.length - 1 ? "0.26em" : 0,
                  opacity: k,
                  filter: `blur(${(1 - k) * px(p, 10)}px)`,
                  transform: `translateY(${interpolate(k, [0, 1], [titleSize * 0.45, 0])}px)`,
                }}
              >
                {word}
              </span>
            );
          })}
        </div>
        <div
          style={{
            width: px(p, 140) * enter(wordsDoneMs + 80),
            height: px(p, 6),
            borderRadius: 3,
            marginTop: px(p, 40),
            background: `linear-gradient(90deg, ${p.brand.primary}, ${p.brand.accent === "#0F172A" ? "#fff" : p.brand.accent})`,
            boxShadow: `0 0 ${px(p, 24)}px ${p.brand.primary}`,
          }}
        />
        {p.subtitle ? (
          <div
            style={{
              color: "rgba(255, 255, 255, 0.86)",
              fontSize: px(p, form === "wide" ? 34 : 30),
              lineHeight: 1.4,
              marginTop: px(p, 30),
              maxWidth: form === "wide" ? px(p, 1200) : undefined,
              ...rise(wordsDoneMs + 200, 20),
            }}
          >
            {p.subtitle}
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** The app's first screen, filling the frame and slowly pushing in, under the brand's colour. Without it, a moving brand gradient. */
const Backdrop: React.FC<{ p: RenderProps; progress: number }> = ({ p, progress }) => {
  // Dark enough for white words over any app, with the app still recognisable under it.
  const wash = [
    `linear-gradient(135deg, ${p.brand.primary}73, transparent 55%)`,
    "radial-gradient(circle farthest-corner at 50% 50%, rgba(8, 12, 28, 0.45), rgba(8, 12, 28, 0.9))",
  ].join(", ");
  if (!p.hero) {
    const x = 25 + 30 * progress;
    return (
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${x}% 25%, ${p.brand.primary}cc, transparent 55%), radial-gradient(circle at ${100 - x}% 85%, ${p.brand.primary}55, transparent 60%), #0b1020`,
        }}
      />
    );
  }
  const scale = 1.12 + 0.1 * progress;
  return (
    <AbsoluteFill>
      <Img
        src={asset(p, p.hero)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translate(${-1.5 * progress}%, ${-1 * progress}%)`,
          filter: `blur(${px(p, 5)}px) saturate(1.2)`,
        }}
      />
      <AbsoluteFill style={{ background: wash }} />
    </AbsoluteFill>
  );
};

/** One soft diagonal light sweeping across the frame as the title comes in. */
const Sweep: React.FC<{ p: RenderProps; ms: number }> = ({ p, ms }) => {
  const k = interpolate(ms, [150, 1300], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (k <= 0 || k >= 1) return null;
  const x = -40 + 180 * k;
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(105deg, transparent ${x - 12}%, rgba(255, 255, 255, 0.10) ${x}%, transparent ${x + 12}%)`,
        mixBlendMode: "screen",
        width: p.width,
      }}
    />
  );
};
