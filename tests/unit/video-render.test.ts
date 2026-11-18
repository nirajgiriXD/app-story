import { describe, expect, it } from "vitest";
import { VOICE_CHAIN } from "@app-story/narration";
import {
  activeStretches,
  beatOffsetMs,
  buildAudioMix,
  findBeats,
  onsets,
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
  chunkKey,
  chunksOf,
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

  it("starts the music where it was put on the beat", () => {
    const mix = buildAudioMix({ ...props, music: { src: "assets/music.mp3", volume: 0.1, offsetMs: 230 } } as RenderProps, 1, (src) => src);
    expect(mix.filter).toContain("atrim=start=0.23:duration=10,asetpts=PTS-STARTPTS");
  });
});

describe("the music's beat", () => {
  /** A drum loop as the analysis reads it: [low, high] samples, a kick on each beat and a hat between. */
  function drums(bpm: number, firstBeatSec: number, seconds: number): Float32Array {
    const rate = 11025;
    const period = 60 / bpm;
    const out = new Float32Array(rate * seconds * 2);
    let noise = 1;
    for (let i = 0; i < rate * seconds; i++) {
      const t = i / rate;
      const sinceBeat = (((t - firstBeatSec) % period) + period) % period;
      const sinceHat = (((t - firstBeatSec - period / 2) % period) + period) % period;
      noise = (noise * 16807) % 2147483647; // the same "random" noise every run
      const hiss = (noise / 2147483647) * 2 - 1;
      out[i * 2] = 0.8 * Math.exp(-sinceBeat * 30) * Math.sin(2 * Math.PI * 60 * t) + 0.01 * hiss;
      out[i * 2 + 1] = 0.2 * Math.exp(-sinceHat * 60) * hiss + 0.01 * hiss;
    }
    return out;
  }

  it("finds the tempo and where the beats fall", () => {
    const beats = findBeats(onsets(drums(124, 0.37, 30)), 11025 / 256);
    expect(beats?.bpm).toBeCloseTo(124, 0);
    // Within one analysis frame (23 ms) of the first kick.
    expect(Math.abs((beats?.phaseSec ?? 0) - 0.37)).toBeLessThan(0.03);
  });

  it("finds no beat in a steady hiss", () => {
    let noise = 7;
    const hiss = new Float32Array(11025 * 20 * 2).map(() => {
      noise = (noise * 16807) % 2147483647;
      return ((noise / 2147483647) * 2 - 1) * 0.1;
    });
    expect(findBeats(onsets(hiss), 11025 / 256)).toBeUndefined();
  });

  it("starts the music so a beat lands on the moment, never more than a beat in", () => {
    const beats = { periodSec: 0.5, phaseSec: 0.1, bpm: 120, confidence: 0.6, durationSec: 60 };
    const at = 13_420;
    const offset = beatOffsetMs(beats, at);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(500);
    // Where the track is at that moment, from its first beat: a whole number of beats.
    expect(((at + offset - 100) / 500) % 1).toBeCloseTo(0);
    // The music loops: the moment counts from the start of its loop.
    expect(beatOffsetMs({ ...beats, durationSec: 10 }, at)).toBe(beatOffsetMs({ ...beats, durationSec: 10 }, at - 10_000));
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

describe("render cache", () => {
  const template = getTemplate("modern-saas");
  const base: RenderProps = {
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 40_000,
    template,
    brand: { productName: "Acme", logo: null, primary: "#2563EB", accent: "#0F172A", font: "Inter", host: "acme.test" },
    title: "Create a project",
    subtitle: null,
    hero: null,
    intro: { startMs: 0, endMs: 3000 },
    outro: { startMs: 36_000, endMs: 40_000 },
    recording: { src: "recording/raw.mp4", startMs: 2500, durationMs: 34_000, viewport: { width: 1600, height: 900 } },
    sections: [],
    focus: [
      { startMs: 2000, endMs: 4000, box: { x: 100, y: 100, width: 300, height: 200 } },
      { startMs: 25_000, endMs: 27_000, box: { x: 900, y: 500, width: 300, height: 200 } },
    ],
    cuts: [],
    cursor: [
      { t: 0, x: 800, y: 450 },
      { t: 2000, x: 200, y: 200, click: true },
      { t: 25_000, x: 1000, y: 600, click: true },
    ],
    urls: [{ atMs: 0, url: "https://acme.test/" }],
    audio: [{ src: "narration/seg-01.wav", startMs: 3000, durationMs: 2000 }],
    captions: { enabled: true, fontSize: 38, position: "bottom", cues: [{ startMs: 3000, endMs: 5000, text: "Open the form." }] },
    music: null,
  };
  const inputs = { page: "page", files: "files", encoding: ["x264"] };
  const chunks = chunksOf(Math.round((base.durationMs / 1000) * base.fps), base.fps);
  const keys = (p: RenderProps) => chunks.map((c) => chunkKey(p, c, inputs));
  const changed = (a: string[], b: string[]) => a.flatMap((k, i) => (k === b[i] ? [] : [i]));

  it("cuts the video into two-second chunks that cover it once", () => {
    expect(chunks).toHaveLength(20);
    expect(chunks[0]).toEqual({ index: 0, from: 0, to: 60 });
    expect(chunks.at(-1)?.to).toBe(1200);
  });

  it("redraws only the chunks a change of framing can reach", () => {
    const moved = {
      ...base,
      focus: [base.focus[0], { ...(base.focus[1] as RenderProps["focus"][number]), box: { x: 0, y: 0, width: 200, height: 200 } }],
    } as RenderProps;
    const diff = changed(keys(base), keys(moved));
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.length).toBeLessThan(10);
    // Around 27.5s of the video (the window plays from 2.5s into the recording, 25s in).
    expect(diff.every((i) => i >= 9 && i <= 17)).toBe(true);
  });

  it("gives every chunk of the video its own key, even where nothing moves", () => {
    expect(new Set(keys(base)).size).toBe(chunks.length);
  });

  it("redraws nothing for a change of sound, and everything for a change of look", () => {
    const louder = { ...base, audio: [], music: { src: "assets/music.mp3", volume: 0.2 }, sfx: [{ kind: "click" as const, atMs: 100 }] };
    expect(changed(keys(base), keys(louder))).toEqual([]);
    const otherLook = { ...base, template: getTemplate("minimal") };
    expect(changed(keys(base), keys(otherLook))).toHaveLength(chunks.length);
    expect(
      changed(
        keys(base),
        chunks.map((c) => chunkKey(base, c, { ...inputs, page: "new page code" })),
      ),
    ).toHaveLength(chunks.length);
  });

  it("redraws the chunks whose caption changed", () => {
    const reworded = { ...base, captions: { ...base.captions, cues: [{ startMs: 3000, endMs: 5000, text: "Open the new form." }] } };
    expect(changed(keys(base), keys(reworded))).toEqual([1, 2]);
  });

  it("redraws the chunks whose recording frames changed with the edit", () => {
    const edited = {
      ...base,
      recording: {
        ...base.recording,
        timeMap: [
          [0, 0],
          [10_000, 10_000],
          [12_000, 18_000],
          [34_000, 40_000],
        ] as [number, number][],
      },
    };
    const diff = changed(keys(base), keys(edited));
    expect(diff[0]).toBe(6); // from 12.5s of the video on
    expect(diff).not.toContain(0);
  });
});
