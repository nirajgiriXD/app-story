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
  name,
  children,
}) => {
  const frame = useCurrentFrame();
  if (frame < from || frame >= from + durationInFrames) return null;
  // The name marks the layer in the page (and in the golden frames' markup).
  return (
    <FrameContext.Provider value={frame - from}>
      <div data-sequence={name} style={fill}>
        {children}
      </div>
    </FrameContext.Provider>
  );
};

/** An image that is decoded before the frame is captured. */
export const Img: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = (props) => <img alt="" decoding="sync" {...props} />;

export { interpolate, spring } from "./animation";
