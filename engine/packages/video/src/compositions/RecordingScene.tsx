import React, { useMemo } from "react";
import { AbsoluteFill, OffthreadVideo, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderProps } from "../props";
import { cameraAt, cameraTransform, cursorAt, latestAt, mergeFocusWindows } from "../timeline";
import { asset, fontStack, isDark, px } from "./theme";

/** Window layout in output pixels. */
function layout(p: RenderProps) {
  const { viewport } = p.recording;
  if (p.template.frame === "full") {
    const scale = Math.min(p.width / viewport.width, p.height / viewport.height);
    return { x: (p.width - viewport.width * scale) / 2, y: (p.height - viewport.height * scale) / 2, scale, bar: 0, radius: 0 };
  }
  // Fixed zones keep overlays off the product UI: chapter chip above, captions below.
  const bar = px(p, 46);
  const top = px(p, 84);
  const bottom = p.captions.enabled ? px(p, 152) : px(p, 56);
  const maxW = p.width * 0.9;
  const maxH = p.height - top - bottom - bar;
  const scale = Math.min(maxW / viewport.width, maxH / viewport.height);
  const w = viewport.width * scale;
  return { x: (p.width - w) / 2, y: top, scale, bar, radius: px(p, 18) };
}

export const RecordingScene: React.FC<{ p: RenderProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = (frame / fps) * 1000;
  const { viewport } = p.recording;
  const L = layout(p);
  const groups = useMemo(() => mergeFocusWindows(p.focus), [p.focus]);

  const camera = p.template.zoom.enabled ? cameraAt(t, groups, viewport, p.template.zoom) : { scale: 1, x: viewport.width / 2, y: viewport.height / 2 };
  const view = cameraTransform(camera, viewport);
  const cursor = cursorAt(t, p.cursor);
  const fade = p.template.transitionMs;
  const opacity = interpolate(t, [0, fade, p.recording.durationMs - fade, p.recording.durationMs], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const appear = spring({ frame, fps, config: { damping: 200 } });
  const url = latestAt(t, p.urls)?.url ?? "";
  const section = latestAt(t, p.sections);

  const content = (
    <div style={{ position: "relative", width: viewport.width * L.scale, height: viewport.height * L.scale, overflow: "hidden" }}>
      <div
        style={{
          width: viewport.width,
          height: viewport.height,
          transformOrigin: "0 0",
          transform: `scale(${L.scale * view.scale}) translate(${view.tx}px, ${view.ty}px)`,
          position: "relative",
        }}
      >
        <OffthreadVideo src={asset(p, p.recording.src)} muted style={{ width: viewport.width, height: viewport.height, display: "block" }} />
        {cursor ? <Cursor p={p} x={cursor.x} y={cursor.y} sinceClickMs={cursor.sinceClickMs} zoom={view.scale} /> : null}
      </div>
    </div>
  );

  return (
    <AbsoluteFill style={{ opacity, fontFamily: fontStack(p.brand.font) }}>
      <div
        style={{
          position: "absolute",
          left: L.x,
          top: L.y,
          borderRadius: L.radius,
          overflow: "hidden",
          boxShadow: L.radius ? "0 30px 80px rgba(15, 23, 42, 0.28), 0 0 0 1px rgba(15, 23, 42, 0.08)" : undefined,
          transform: L.radius ? `translateY(${interpolate(appear, [0, 1], [px(p, 30), 0])}px)` : undefined,
          background: "#fff",
        }}
      >
        {L.bar ? <WindowBar p={p} url={url} height={L.bar} /> : null}
        {content}
      </div>
      {p.template.sectionStyle === "chip" && section ? (
        <SectionChip
          p={p}
          title={section.title}
          sinceMs={t - section.atMs}
          left={L.radius ? L.x : px(p, 48)}
          top={L.radius ? (L.y - px(p, 52)) / 2 : px(p, 40)}
        />
      ) : null}
    </AbsoluteFill>
  );
};

const WindowBar: React.FC<{ p: RenderProps; url: string; height: number }> = ({ p, url, height }) => {
  const dark = isDark(p);
  const dot = (color: string) => <span style={{ width: height * 0.26, height: height * 0.26, borderRadius: "50%", background: color, display: "inline-block" }} />;
  let display = url;
  try {
    const u = new URL(url);
    display = `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    // keep raw
  }
  return (
    <div
      style={{
        height,
        display: "flex",
        alignItems: "center",
        gap: height * 0.18,
        padding: `0 ${height * 0.4}px`,
        background: dark ? "#1E293B" : "#F1F5F9",
        borderBottom: `1px solid ${dark ? "#334155" : "#E2E8F0"}`,
      }}
    >
      {dot("#FF5F57")}
      {dot("#FEBC2E")}
      {dot("#28C840")}
      <div
        style={{
          marginLeft: height * 0.4,
          flex: 1,
          maxWidth: "55%",
          height: height * 0.6,
          borderRadius: height * 0.3,
          background: dark ? "#0F172A" : "#fff",
          color: dark ? "#CBD5E1" : "#475569",
          fontSize: height * 0.32,
          display: "flex",
          alignItems: "center",
          padding: `0 ${height * 0.35}px`,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {display}
      </div>
    </div>
  );
};

const Cursor: React.FC<{ p: RenderProps; x: number; y: number; sinceClickMs: number | null; zoom: number }> = ({ p, x, y, sinceClickMs, zoom }) => {
  const size = p.template.cursor.size / zoom;
  const ripple = sinceClickMs !== null && sinceClickMs >= 0 && sinceClickMs < 650 ? sinceClickMs / 650 : null;
  return (
    <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none" }}>
      {p.template.cursor.highlight ? (
        <div
          style={{
            position: "absolute",
            left: -size * 0.9,
            top: -size * 0.9,
            width: size * 1.8,
            height: size * 1.8,
            borderRadius: "50%",
            background: `${p.brand.primary}26`,
          }}
        />
      ) : null}
      {ripple !== null ? (
        <div
          style={{
            position: "absolute",
            left: -size * (0.5 + ripple * 1.2),
            top: -size * (0.5 + ripple * 1.2),
            width: size * (1 + ripple * 2.4),
            height: size * (1 + ripple * 2.4),
            borderRadius: "50%",
            border: `${Math.max(1, 3 / zoom)}px solid ${p.brand.primary}`,
            opacity: 1 - ripple,
          }}
        />
      ) : null}
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: "absolute", left: -size * 0.12, top: -size * 0.06, filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.35))" }}>
        <path d="M4 2 L4 20 L9 15.5 L12.5 22.5 L15.5 21 L12 14 L19 14 Z" fill="#0F172A" stroke="#FFFFFF" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

const SectionChip: React.FC<{ p: RenderProps; title: string; sinceMs: number; left: number; top: number }> = ({ p, title, sinceMs, left, top }) => {
  const { fps } = useVideoConfig();
  if (sinceMs < 0 || sinceMs > 3200) return null;
  const inK = spring({ frame: (sinceMs / 1000) * fps, fps, config: { damping: 200 } });
  const out = interpolate(sinceMs, [2700, 3200], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        height: px(p, 52),
        boxSizing: "border-box",
        opacity: inK * out,
        transform: `translateY(${interpolate(inK, [0, 1], [-px(p, 16), 0])}px)`,
        background: p.brand.accent,
        color: "#fff",
        borderRadius: 999,
        padding: `${px(p, 10)}px ${px(p, 24)}px`,
        fontSize: px(p, 26),
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        gap: px(p, 12),
        boxShadow: "0 10px 30px rgba(15,23,42,0.25)",
      }}
    >
      <span style={{ width: px(p, 10), height: px(p, 10), borderRadius: "50%", background: p.brand.primary, display: "inline-block" }} />
      {title}
    </div>
  );
};
