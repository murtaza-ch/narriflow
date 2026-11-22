import { describe, expect, test } from "bun:test";
import {
  SCENE_MAX_SAMPLE_FPS,
  exportFrameAfter,
  exportFrameAtOrAfter,
  exportFrameAtOrBefore,
  exportFrameTimes,
  paintedFrameCount,
} from "./frame-grid";

describe("the export frame grid", () => {
  test("frame times are the worker's rounded integer ms", () => {
    expect(exportFrameTimes(0, 140, 30)).toEqual([0, 33, 67, 100, 133]);
    expect(exportFrameTimes(50, 120, 30)).toEqual([67, 100]);
    expect(exportFrameTimes(10, 20, 30)).toEqual([]);
    expect(exportFrameTimes(0, 100, 240)).toEqual(exportFrameTimes(0, 100, SCENE_MAX_SAMPLE_FPS));
    expect(exportFrameTimes(0, 200, 25)).toEqual([0, 40, 80, 120, 160]);
  });

  for (const fps of [24, 25, 30, 50, 60]) {
    test(`at ${fps} fps the frame helpers agree with the frame list`, () => {
      const all = exportFrameTimes(0, 6000, fps);
      for (let t = 0; t <= 5900; t++) {
        const after = all.find((frame) => frame > t)!;
        const atOrAfter = all.find((frame) => frame >= t)!;
        const atOrBefore = [...all].reverse().find((frame) => frame <= t)!;
        expect(exportFrameAfter(t, fps)).toBe(after);
        expect(exportFrameAtOrAfter(t, fps)).toBe(atOrAfter);
        expect(exportFrameAtOrBefore(t, fps)).toBe(atOrBefore);
      }
    });
  }

  test("a 67 ms piece paints on one or two frames depending on where it starts", () => {
    expect(paintedFrameCount(0, 67, 30)).toBe(2);
    expect(paintedFrameCount(1, 68, 30)).toBe(2);
    expect(paintedFrameCount(34, 67, 30)).toBe(0);
    expect(paintedFrameCount(30, 97, 30)).toBe(2);
    expect(paintedFrameCount(0, 67, 24)).toBe(2);
    expect(paintedFrameCount(10, 77, 24)).toBe(1);
  });
});
