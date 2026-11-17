import { describe, expect, it } from "vitest";
import { VOICE_CHAIN } from "@app-story/narration";
import {
  activeStretches,
  buildAudioMix,
  deliveryEncoding,
  getTemplate,
  MASTER_LOUDNESS,
  masterChain,
  handoverIn,
  handoverOut,
  interpolate,
  jpegEnd,
  musicVolumeExpression,
  planEdit,
  type RenderProps,
  spring,
  sourceFrame,
  splitFrames,
  toOutput,
  toSource,
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

describe("sound", () => {
  it("masters the mix with one measured gain and a peak limiter", () => {
    const chain = masterChain({ i: -17.2, tp: -3.1, lra: 4.2, thresh: -27.5, offset: 0.3 });
    expect(chain).toContain(`loudnorm=I=${MASTER_LOUDNESS.i}:`);
    expect(chain).toContain("measured_I=-17.2:");
    expect(chain).toContain("linear=true");
    expect(chain).toMatch(/aresample=48000,alimiter=/);
  });

  it("leaves silence alone instead of turning it up", () => {
    expect(masterChain({ i: Number.NEGATIVE_INFINITY, tp: Number.NEGATIVE_INFINITY, lra: 0, thresh: -70, offset: 0 })).not.toContain("loudnorm");
    expect(masterChain(undefined)).not.toContain("loudnorm");
  });

  it("cleans up the voice before setting its loudness", () => {
    expect(VOICE_CHAIN).toMatch(/^highpass=f=80,deesser=.*acompressor=.*equalizer=/);
  });
});

describe("delivery encoding", () => {
  it("encodes for sharp screen text with a keyframe every two seconds", () => {
    const args = deliveryEncoding(60);
    expect(args).toEqual(expect.arrayContaining(["libx264", "slow", "high"]));
    expect(args[args.indexOf("-g") + 1]).toBe("120");
    expect(args[args.indexOf("-x264-params") + 1]).toContain("aq-mode=3");
  });
});

describe("the editor's pass", () => {
  it("plays a take as recorded when something always happens", () => {
    const map = planEdit(10_000, [[0, 10_000]]);
    expect(toOutput(map, 7000)).toBe(7000);
    expect(sourceFrame(map, 90, 60)).toBe(90);
    expect(sourceFrame(undefined, 90, 60)).toBe(90);
  });

  it("fast-forwards an idle stretch, keeping a moment at normal speed at each end", () => {
    // Voice until 3 s, then a 6 s spinner, then action again.
    const map = planEdit(12_000, [
      [0, 3000],
      [9000, 12_000],
    ]);
    const idleShown = toOutput(map, 9000) - toOutput(map, 3000);
    expect(idleShown).toBeCloseTo(400 + (6000 - 800) / 4 + 400);
    expect(toOutput(map, 3400)).toBeCloseTo(3400); // normal speed just after the action
    expect(toOutput(map, 12_000) - toOutput(map, 9000)).toBeCloseTo(3000);
    for (const out of [0, 2500, 3600, 5000, 6900, 8000]) expect(toOutput(map, toSource(map, out))).toBeCloseTo(out);
    // Frames never go backwards.
    let last = -1;
    for (let f = 0; f < 600; f++) {
      const src = sourceFrame(map, f, 60);
      expect(src).toBeGreaterThanOrEqual(last);
      last = src;
    }
  });

  it("leaves short pauses alone", () => {
    expect(
      planEdit(5000, [
        [0, 2000],
        [3000, 5000],
      ]),
    ).toEqual([
      [0, 0],
      [5000, 5000],
    ]);
  });

  it("counts voice, pointer moves, clicks, typing and page changes as something happening", () => {
    const active = activeStretches({
      durationMs: 20_000,
      steps: [{ step_id: "s", action: "fill", description: "", status: "passed", started_ms: 4000, ended_ms: 6000, attempts: 1, verified: true }],
      cursor: [
        { t: 1000, x: 0, y: 0 },
        { t: 1500, x: 100, y: 100 },
        { t: 1600, x: 100, y: 100, click: true },
      ],
      navigations: [{ t: 8000, url: "https://acme.test/x" }],
      voice: [{ start_ms: 10_000, duration_ms: 2000 }],
    });
    expect(active).toEqual(
      expect.arrayContaining([
        [1000, 1500],
        [1300, 2800],
        [4000, 6000],
        [7800, 8700],
        [9850, 12_150],
      ]),
    );
    const map = planEdit(20_000, active);
    expect(toOutput(map, 20_000)).toBeLessThan(20_000);
  });
});
