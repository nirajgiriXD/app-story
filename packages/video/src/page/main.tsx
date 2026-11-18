import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { DemoVideo } from "../compositions/DemoVideo";
import { VideoRoot, type VideoConfig } from "../compositions/runtime";
import type { RenderProps } from "../props";

/*
 * The render page. The renderer loads it in a headless browser tab, calls `setup` once
 * with the video's props, then `renderFrame` for each frame and captures the tab.
 */

declare global {
  interface Window {
    appStory: {
      setup(props: RenderProps): Promise<void>;
      renderFrame(frame: number): Promise<void>;
    };
  }
}

let root: Root | undefined;
let props: RenderProps | undefined;
let config: VideoConfig | undefined;

window.appStory = {
  async setup(p) {
    props = p;
    config = { fps: p.fps, width: p.width, height: p.height, durationInFrames: Math.max(1, Math.round((p.durationMs / 1000) * p.fps)) };
    const container = document.getElementById("root");
    if (!container) throw new Error("The render page has no root element.");
    root = createRoot(container);
    // Load the Latin faces before the first frame; other scripts load when text needs them.
    await Promise.all([document.fonts.load("16px Inter", "Aa"), document.fonts.load(`16px "${p.brand.font}"`, "Aa")]).catch(() => undefined);
  },

  async renderFrame(frame) {
    if (!root || !props || !config) throw new Error("The render page was not set up.");
    const p = props;
    const c = config;
    flushSync(() => {
      root?.render(
        <VideoRoot frame={frame} config={c}>
          <DemoVideo {...p} />
        </VideoRoot>,
      );
    });
    // Every image (the recording frame, the logo) must be decoded, and every font loaded, before the capture.
    await Promise.all(Array.from(document.images, (img) => img.decode().catch(() => undefined)));
    // Laying out first starts the loads of any font the new text needs, which `ready` then waits for.
    void document.body.offsetHeight;
    await document.fonts.ready;
  },
};
