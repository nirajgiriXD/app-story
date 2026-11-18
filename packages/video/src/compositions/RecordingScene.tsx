import type React from "react";
import { useMemo } from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "./runtime";
import type { RenderProps } from "../props";
import { menuLayout } from "@app-story/contracts/menu";
import { cameraAt, cameraTransform, cursorAt, cursorPresence, latestAt, menuAt, mergeFocusWindows } from "../timeline";
import { sourceFrame } from "../edit";
import { handoverIn, handoverOut } from "./handover";
import { fontStack, isDark, px, recordingFrame, shape } from "./theme";

/** Window layout in output pixels. */
export function layout(p: RenderProps) {
  const { viewport } = p.recording;
  if (p.template.frame === "full") {
    const scale = Math.min(p.width / viewport.width, p.height / viewport.height);
    return { x: (p.width - viewport.width * scale) / 2, y: (p.height - viewport.height * scale) / 2, scale, bar: 0, radius: 0 };
  }
  const bar = px(p, 46);
  if (shape(p) !== "wide") {
    // Portrait or square: the window spans the width, a little above the middle, with the
    // captions right under it (see DemoVideo's Captions).
    const scale = (p.width * 0.94) / viewport.width;
    const height = bar + viewport.height * scale;
    return { x: p.width * 0.03, y: Math.max(px(p, 120), (p.height - height) / 2 - px(p, 60)), scale, bar, radius: px(p, 18) };
  }
  // Fixed zones keep overlays off the product UI: chapter chip above, captions below.
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
  const groups = useMemo(() => mergeFocusWindows(p.focus, 1200, p.cuts ?? []), [p.focus, p.cuts]);

  const camera = p.template.zoom.enabled ? cameraAt(t, groups, viewport, p.template.zoom) : { scale: 1, x: viewport.width / 2, y: viewport.height / 2 };
  const view = cameraTransform(camera, viewport);
  const cursor = cursorAt(t, p.cursor);
  const fade = p.template.transitionMs;
  // Arrives after the intro's text has left and leaves before the outro's arrives (handover.ts).
  const arrive = handoverIn(t, fade);
  const leave = handoverOut(t, p.recording.durationMs, fade);
  const opacity = arrive * (1 - leave);
  const url = latestAt(t, p.urls)?.url ?? "";
  const section = latestAt(t, p.sections);
  const pressed = latestAt(t, p.keys ?? []);
  const open = menuAt(t, p.menus ?? []);

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
        <Img src={recordingFrame(sourceFrame(p.recording.timeMap, frame, fps))} style={{ width: viewport.width, height: viewport.height, display: "block" }} />
        {camera.focus && p.template.spotlight > 0 ? (
          <Spotlight box={camera.focus.box} strength={p.template.spotlight * camera.focus.amount} zoom={view.scale} />
        ) : null}
        {open ? <DropdownList p={p} menu={open.menu} shown={open.shown} pointer={cursor} /> : null}
        {cursor ? <Cursor p={p} t={t} x={cursor.x} y={cursor.y} sinceClickMs={cursor.sinceClickMs} zoom={view.scale} /> : null}
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
          transform: `translateY(${px(p, 40) * (1 - arrive)}px) scale(${0.96 + 0.04 * arrive - 0.03 * leave})`,
          background: "#fff",
        }}
      >
        {L.bar ? <WindowBar p={p} url={url} height={L.bar} /> : null}
        {content}
      </div>
      {pressed ? (
        <KeyChip
          p={p}
          labels={pressed.labels}
          sinceMs={t - pressed.atMs}
          centerX={L.x + (viewport.width * L.scale) / 2}
          bottom={L.y + L.bar + viewport.height * L.scale - px(p, 36)}
        />
      ) : null}
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
  const dot = (color: string) => (
    <span style={{ width: height * 0.26, height: height * 0.26, borderRadius: "50%", background: color, display: "inline-block" }} />
  );
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

/**
 * Dims the screen around the area being shown, softly, so the eye goes where the narration
 * is. It moves with the camera, in the recording's own pixels.
 */
const Spotlight: React.FC<{ box: { x: number; y: number; width: number; height: number }; strength: number; zoom: number }> = ({ box, strength, zoom }) => {
  if (strength <= 0.001) return null;
  const pad = 14;
  return (
    <div
      style={{
        position: "absolute",
        left: box.x - pad,
        top: box.y - pad,
        width: box.width + pad * 2,
        height: box.height + pad * 2,
        borderRadius: 14,
        boxShadow: `0 0 ${48 / zoom}px ${24 / zoom}px rgba(15, 23, 42, ${strength}), 0 0 0 4000px rgba(15, 23, 42, ${strength})`,
        pointerEvents: "none",
      }}
    />
  );
};

/**
 * A native dropdown's list, drawn where the browser would have shown it (it draws it
 * outside the page, so the recording never has it). The row under the pointer is
 * highlighted, like a real menu; before the pointer gets there, the current choice is.
 */
const DropdownList: React.FC<{
  p: RenderProps;
  menu: NonNullable<RenderProps["menus"]>[number];
  shown: number;
  pointer: { x: number; y: number } | null;
}> = ({ p, menu, shown, pointer }) => {
  const list = menuLayout(menu.field, menu, p.recording.viewport);
  const top = list.y + 4;
  const under = pointer && pointer.x >= list.x && pointer.x <= list.x + list.width ? Math.floor((pointer.y - top) / list.rowHeight) : -1;
  const hovered = under >= 0 && under < list.rows ? list.first + under : menu.from;
  const rows = menu.options.slice(list.first, list.first + list.rows);
  return (
    <div
      style={{
        position: "absolute",
        left: list.x,
        top: list.y,
        width: list.width,
        padding: "4px 0",
        background: "#FFFFFF",
        borderRadius: 8,
        border: "1px solid rgba(15, 23, 42, 0.12)",
        boxShadow: "0 12px 32px rgba(15, 23, 42, 0.22)",
        opacity: shown,
        transform: `translateY(${(1 - shown) * -6}px)`,
        transformOrigin: "top",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontSize: Math.round(list.rowHeight * 0.45),
        color: "#0F172A",
        overflow: "hidden",
      }}
    >
      {rows.map((label, i) => {
        const index = list.first + i;
        const active = index === hovered;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: the rows are fixed while the list is open
            key={i}
            style={{
              height: list.rowHeight,
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              background: active ? p.brand.primary : "transparent",
              color: active ? "#FFFFFF" : "#0F172A",
            }}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
};

/** The pointer's arrow, drawn at the tip (0, 0). */
const Arrow: React.FC<{ size: number; style?: React.CSSProperties }> = ({ size, style }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    style={{ position: "absolute", left: -size * 0.12, top: -size * 0.06, filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.35))", ...style }}
  >
    <path d="M4 2 L4 20 L9 15.5 L12.5 22.5 L15.5 21 L12 14 L19 14 Z" fill="#0F172A" stroke="#FFFFFF" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

const Cursor: React.FC<{ p: RenderProps; t: number; x: number; y: number; sinceClickMs: number | null; zoom: number }> = ({
  p,
  t,
  x,
  y,
  sinceClickMs,
  zoom,
}) => {
  const size = p.template.cursor.size / zoom;
  const ripple = sinceClickMs !== null && sinceClickMs >= 0 && sinceClickMs < 650 ? sinceClickMs / 650 : null;
  // A click presses the arrow in a little and lets it spring back.
  const press = sinceClickMs !== null && sinceClickMs >= 0 && sinceClickMs < 240 ? Math.sin((sinceClickMs / 240) * Math.PI) : 0;
  const presence = cursorPresence(t, p.cursor);
  if (presence <= 0.001) return null;
  // On fast moves a faint trail follows the arrow, like motion blur.
  const trail = [14, 28, 42].flatMap((ago, i) => {
    const at = cursorAt(t - ago, p.cursor);
    if (!at || Math.hypot(at.x - x, at.y - y) < 6 / zoom) return [];
    return [{ dx: at.x - x, dy: at.y - y, opacity: [0.22, 0.12, 0.06][i] as number }];
  });
  return (
    <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none", opacity: presence }}>
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
      {trail.map((g) => (
        <Arrow key={g.opacity} size={size} style={{ transform: `translate(${g.dx}px, ${g.dy}px)`, opacity: g.opacity, filter: "none" }} />
      ))}
      <Arrow size={size} style={{ transform: `scale(${1 - 0.18 * press})`, transformOrigin: "0 0" }} />
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

/** How long a pressed key stays on screen. */
const KEY_CHIP_MS = 1500;

/** The keys just pressed, as keycaps near the bottom of the app window, like a screencast key overlay. */
const KeyChip: React.FC<{ p: RenderProps; labels: string[]; sinceMs: number; centerX: number; bottom: number }> = ({ p, labels, sinceMs, centerX, bottom }) => {
  const { fps } = useVideoConfig();
  if (sinceMs < 0 || sinceMs > KEY_CHIP_MS) return null;
  const inK = spring({ frame: (sinceMs / 1000) * fps, fps, config: { damping: 18, mass: 0.6 } });
  const out = interpolate(sinceMs, [KEY_CHIP_MS - 350, KEY_CHIP_MS], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const size = px(p, 30);
  return (
    <div
      style={{
        position: "absolute",
        left: centerX,
        top: bottom,
        transform: `translate(-50%, -100%) scale(${0.85 + 0.15 * inK})`,
        opacity: Math.min(inK, 1) * out,
        display: "flex",
        alignItems: "center",
        gap: px(p, 10),
        padding: `${px(p, 12)}px ${px(p, 16)}px`,
        borderRadius: px(p, 18),
        background: "rgba(15, 23, 42, 0.86)",
        boxShadow: "0 12px 32px rgba(15, 23, 42, 0.35)",
        fontFamily: fontStack(p.brand.font),
      }}
    >
      {labels.map((label, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: keycaps are fixed for the chip's life
          key={i}
          style={{
            minWidth: size * 1.4,
            textAlign: "center",
            padding: `${px(p, 6)}px ${px(p, 14)}px`,
            borderRadius: px(p, 10),
            background: "#F8FAFC",
            color: "#0F172A",
            fontSize: size,
            fontWeight: 600,
            lineHeight: 1.2,
            boxShadow: `inset 0 -${px(p, 4)}px 0 rgba(15, 23, 42, 0.18)`,
          }}
        >
          {label}
        </span>
      ))}
    </div>
  );
};
