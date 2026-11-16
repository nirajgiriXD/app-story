import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { DemoVideo } from "../compositions/DemoVideo";
import type { RenderProps } from "../props";
import { TEMPLATES } from "../templates";

const calculateMetadata: CalculateMetadataFunction<RenderProps> = ({ props }) => ({
  durationInFrames: Math.max(1, Math.round((props.durationMs / 1000) * props.fps)),
  fps: props.fps,
  width: props.width,
  height: props.height,
});

/** Placeholder props so the composition can be opened in Remotion Studio. */
const defaultProps: RenderProps = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationMs: 6000,
  assetBase: "",
  template: TEMPLATES["modern-saas"] as RenderProps["template"],
  brand: { productName: "Product", logo: null, primary: "#2563EB", accent: "#0F172A", font: "Inter", host: "example.com" },
  title: "Demo title",
  subtitle: null,
  intro: { startMs: 0, endMs: 3000 },
  outro: { startMs: 3000, endMs: 6000 },
  recording: { src: "recording/raw.mp4", startMs: 2500, durationMs: 1000, viewport: { width: 1920, height: 1080 } },
  sections: [],
  focus: [],
  cursor: [],
  urls: [],
  audio: [],
  captions: { enabled: false, fontSize: 38, position: "bottom", cues: [] },
  music: null,
};

export const Root: React.FC = () => (
  <Composition
    id="DemoVideo"
    component={DemoVideo}
    durationInFrames={180}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={defaultProps}
    calculateMetadata={calculateMetadata}
  />
);
