import { describe, expect, it } from "vitest";
import {
  buildAudioMix,
  getTemplate,
  handoverIn,
  handoverOut,
  interpolate,
  jpegEnd,
  musicVolumeExpression,
  type RenderProps,
  spring,
  splitFrames,
} from "@app-story/video";

describe("animation helpers", () => {
  it("interpolates piecewise, and clamps or extends outside the range", () => {
    expect(interpolate(5, [0, 10], [0, 100])).toBe(50);
    expect(interpolate(15, [0, 10, 20], [0, 100, 0])).toBe(50);
    expect(interpolate(-5, [0, 10], [0, 100])).toBe(-50);
    expect(interpolate(-5, [0, 10], [0, 100], { extrapolateLeft: "clamp" })).toBe(0);
    expect(interpolate(25, [0, 10], [0, 100], { extrapolateRight: "clamp" })).toBe(100);
  });

  it("springs without bounce settle in about half a second", () => {
    const at = (frame: number) => spring({ frame, fps: 30, config: { damping: 200 } });
    expect(at(0)).toBe(0);
    expect(at(5)).toBeGreaterThan(0.4);
    expect(at(20)).toBeGreaterThan(0.99);
    for (let f = 1; f < 40; f++) expect(at(f)).toBeGreaterThanOrEqual(at(f - 1));
  });

  it("springs with little damping overshoot", () => {
    const peak = Math.max(...Array.from({ length: 60 }, (_, f) => spring({ frame: f, fps: 30 })));
    expect(peak).toBeGreaterThan(1.1);
  });
});

describe("render workers", () => {
  it("splits the frames into contiguous stretches that cover the video once", () => {
    const ranges = splitFrames(1000, 4);
    expect(ranges).toHaveLength(4);
    expect(ranges[0]?.[0]).toBe(0);
    expect(ranges[ranges.length - 1]?.[1]).toBe(1000);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]?.[0]).toBe(ranges[i - 1]?.[1]);
  });

  it("does not start a worker for a handful of frames", () => {
    expect(splitFrames(100, 8)).toHaveLength(2);
    expect(splitFrames(1, 8)).toEqual([[0, 1]]);
  });
});

describe("JPEG stream splitting", () => {
  // A minimal JPEG: start, a table whose bytes include FF D9, a scan with stuffed FF00 and a restart marker, end.
  const image = Buffer.from([
    0xff, 0xd8, 0xff, 0xdb, 0x00, 0x06, 0xff, 0xd9, 0x01, 0x02, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, 0xff, 0xd9,
  ]);

  it("finds the end of an image without being fooled by bytes inside it", () => {
    expect(jpegEnd(image)).toBe(image.length);
    const two = Buffer.concat([image, image]);
    expect(jpegEnd(two)).toBe(image.length);
    expect(jpegEnd(two, image.length)).toBe(two.length);
  });

  it("waits for the rest of an image that is not complete yet", () => {
    for (let cut = 0; cut < image.length; cut++) expect(jpegEnd(image.subarray(0, cut))).toBe(-1);
  });

  it("rejects data that is not a JPEG", () => {
    expect(() => jpegEnd(Buffer.from([0x00, 0x01, 0x02]))).toThrow(/Not a JPEG/);
  });
});

describe("audio mix", () => {
  const props = {
    durationMs: 10_000,
    audio: [
      { src: "voice/a.wav", startMs: 1000, durationMs: 2000 },
      { src: "voice/b.wav", startMs: 6000, durationMs: 1000 },
    ],
    music: { src: "assets/music.mp3", volume: 0.1 },
    template: getTemplate("modern-saas"),
  } as unknown as RenderProps;

  it("places each voice clip at its time and loops the music under it", () => {
    const mix = buildAudioMix(props, 1, (src) => `/job/${src}`);
    expect(mix.inputArgs).toEqual(["-i", "/job/voice/a.wav", "-i", "/job/voice/b.wav", "-stream_loop", "-1", "-i", "/job/assets/music.mp3"]);
    expect(mix.filter).toContain("[1:a]");
    expect(mix.filter).toContain("adelay=1000:all=1[v0]");
    expect(mix.filter).toContain("adelay=6000:all=1[v1]");
    expect(mix.filter).toContain("[3:a]");
    expect(mix.filter).toContain("amix=inputs=4:duration=first:normalize=0");
    expect(mix.filter).toMatch(/\[aout\]$/);
  });

  it("is silence of the right length when there is no sound", () => {
    const mix = buildAudioMix({ ...props, audio: [], music: null } as RenderProps, 1, (src) => src);
    expect(mix.inputArgs).toEqual([]);
    expect(mix.filter).toContain("atrim=duration=10");
    expect(mix.filter).toContain("amix=inputs=1");
  });

  it("dips the music under the voice and fades it in and out", () => {
    const expression = musicVolumeExpression(props);
    const clip = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
    const volumeAt = new Function("t", "min", "max", "clip", `return ${expression};`) as (
      t: number,
      min: typeof Math.min,
      max: typeof Math.max,
      c: typeof clip,
    ) => number;
    const at = (t: number) => volumeAt(t, Math.min, Math.max, clip);
    expect(at(0)).toBe(0); // fading in
    expect(at(0.5)).toBeCloseTo(0.05);
    expect(at(4.5)).toBeCloseTo(0.1); // no voice
    expect(at(2)).toBeCloseTo(0.04); // under the voice: 40%
    expect(at(0.75)).toBeGreaterThan(0.04); // dipping as the voice starts
    expect(at(9)).toBeCloseTo(0.05); // fading out over the last 2 seconds
    expect(at(10)).toBe(0);
  });
});

describe("title card handover", () => {
  it("brings the app window in only after the title has mostly gone", () => {
    const fade = 500;
    for (let t = 0; t <= fade; t += 10) {
      const titleGone = handoverOut(t, fade, fade);
      const windowIn = handoverIn(t, fade);
      if (windowIn > 0) expect(titleGone).toBeGreaterThan(0.85);
    }
    expect(handoverIn(fade, fade)).toBe(1);
    expect(handoverOut(fade, fade, fade)).toBe(1);
  });
});
