import { describe, expect, it } from "vitest";
import { browserArgs, imageSize } from "@app-story/browser";

/** The smallest PNG header that `imageSize` reads: signature, then the IHDR chunk. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A JPEG start: SOI, an APP0 segment, then a baseline frame header (SOF0). */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe("recording sharpness", () => {
  it("forces the device scale on a headless browser, so the screencast sends real 2x frames", () => {
    expect(browserArgs(2, true)).toContain("--force-device-scale-factor=2");
    expect(browserArgs(1, true).some((a) => a.startsWith("--force-device-scale-factor"))).toBe(false);
    // A headed window would grow to twice its size on screen.
    expect(browserArgs(2, false).some((a) => a.startsWith("--force-device-scale-factor"))).toBe(false);
  });

  it("reads the pixel size of PNG and JPEG frames", () => {
    expect(imageSize(pngHeader(3200, 1800))).toEqual({ width: 3200, height: 1800 });
    expect(imageSize(jpegHeader(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(imageSize(Buffer.from("not an image"))).toBeUndefined();
  });
});
