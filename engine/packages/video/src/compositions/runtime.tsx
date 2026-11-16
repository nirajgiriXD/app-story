import type React from "react";
import { createContext, useContext } from "react";

/*
 * The few building blocks the compositions need to be drawn one frame at a time: the
 * current frame, sequences that shift it, a full-frame box, and the `interpolate` and
 * `spring` animation helpers. Everything is a pure function of the frame number, so any
 * frame can be drawn on its own, in any order, by any of the render workers.
 */

export interface VideoConfig {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
}

const FrameContext = createContext(0);
const ConfigContext = createContext<VideoConfig>({ fps: 30, width: 1920, height: 1080, durationInFrames: 1 });

export const VideoRoot: React.FC<{ frame: number; config: VideoConfig; children: React.ReactNode }> = ({ frame, config, children }) => (
  <ConfigContext.Provider value={config}>
    <FrameContext.Provider value={frame}>{children}</FrameContext.Provider>
  </ConfigContext.Provider>
);

/** The frame being drawn, counted from the start of the enclosing sequence. */
export function useCurrentFrame(): number {
  return useContext(FrameContext);
}

export function useVideoConfig(): VideoConfig {
  return useContext(ConfigContext);
}

const fill: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  flexDirection: "column",
};

export const AbsoluteFill: React.FC<{ style?: React.CSSProperties; children?: React.ReactNode }> = ({ style, children }) => (
  <div style={{ ...fill, ...style }}>{children}</div>
);

/** Shows its children from frame `from` for `durationInFrames` frames; inside, frames count from 0. */
export const Sequence: React.FC<{ from: number; durationInFrames: number; name?: string; children: React.ReactNode }> = ({
  from,
  durationInFrames,
  children,
}) => {
  const frame = useCurrentFrame();
  if (frame < from || frame >= from + durationInFrames) return null;
  return (
    <FrameContext.Provider value={frame - from}>
      <AbsoluteFill>{children}</AbsoluteFill>
    </FrameContext.Provider>
  );
};

/** An image that is decoded before the frame is captured. */
export const Img: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = (props) => <img alt="" decoding="sync" {...props} />;

type Extrapolate = "extend" | "clamp" | "identity";

/** Map `input` from `inputRange` onto `outputRange`, piecewise linearly. Outside the range it extends by default. */
export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options: { extrapolateLeft?: Extrapolate; extrapolateRight?: Extrapolate } = {},
): number {
  if (inputRange.length !== outputRange.length || inputRange.length < 2) {
    throw new Error("interpolate() needs input and output ranges of the same length, with at least two points.");
  }
  const last = inputRange.length - 1;
  const at = (i: number) => inputRange[i] as number;
  const out = (i: number) => outputRange[i] as number;
  if (input < at(0)) {
    if (options.extrapolateLeft === "clamp") return out(0);
    if (options.extrapolateLeft === "identity") return input;
  }
  if (input > at(last)) {
    if (options.extrapolateRight === "clamp") return out(last);
    if (options.extrapolateRight === "identity") return input;
  }
  let i = 1;
  while (i < last && input > at(i)) i++;
  const x0 = at(i - 1);
  const x1 = at(i);
  const k = x1 === x0 ? 0 : (input - x0) / (x1 - x0);
  return out(i - 1) + (out(i) - out(i - 1)) * k;
}

/**
 * A spring that moves from 0 to 1, starting at rest at frame 0. It is a closed-form
 * solution, so it does not depend on which frames were drawn before.
 *
 * Springs with enough damping not to bounce (damping ratio ≥ 1) move as a critically
 * damped spring, whatever the damping. That is how the animation library the templates
 * were designed with behaves: `damping: 200` means "no bounce, settle in about half a
 * second", not a slow crawl.
 */
export function spring(input: { frame: number; fps: number; config?: { damping?: number; mass?: number; stiffness?: number } }): number {
  const { damping = 10, mass = 1, stiffness = 100 } = input.config ?? {};
  if (input.frame <= 0) return 0;
  const t = input.frame / input.fps;
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const x0 = -1; // starts 1 below the target, at rest
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 + Math.exp(-zeta * omega * t) * (x0 * Math.cos(wd * t) + ((zeta * omega * x0) / wd) * Math.sin(wd * t));
  }
  return 1 + Math.exp(-omega * t) * (x0 + omega * x0 * t);
}
