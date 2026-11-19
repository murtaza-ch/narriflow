import { describe, expect, test } from "bun:test";
import { captionMatteColumnTop } from "@narriflow/caption-fonts/caption-block";
import { canvasMatteFromRegionMask, videoRegion } from "./person-matte-geometry";

const CANVAS = { width: 1080, height: 1920 };

describe("person matte geometry (spec 5.12)", () => {
  test("the segmenter region is scaled from source px to the preview video's px and clamped", () => {
    expect(videoRegion({ x: 656, y: 0, width: 608, height: 1080 }, { width: 1920, height: 1080 }, { width: 1280, height: 720 })).toEqual({ x: 437, y: 0, width: 405, height: 720 });
    expect(videoRegion({ x: 1800, y: 0, width: 400, height: 1080 }, { width: 1920, height: 1080 }, { width: 960, height: 540 })).toEqual({ x: 900, y: 0, width: 60, height: 540 });
  });

  test("a region matte maps through crop and destination to canvas space, zero outside the layer", () => {
    // A 4x4 matte over the crop: the bottom half is the person.
    const data = new Uint8Array(16);
    for (let index = 8; index < 16; index++) data[index] = 255;
    const crop = { x: 656, y: 0, width: 608, height: 1080 };
    const canvasMatte = canvasMatteFromRegionMask({
      matte: { width: 4, height: 4, data, region: crop },
      crop,
      destination: { x: 0, y: 0, width: 1080, height: 960 }, // the top tile of a two-up
      canvas: CANVAS,
    });
    expect(captionMatteColumnTop(canvasMatte, CANVAS, 540)).toBeCloseTo(480, -1);
    // Below the tile nothing is the person, even though the matte's bottom row is.
    const bottom = canvasMatte.data[(canvasMatte.height - 1) * canvasMatte.width + canvasMatte.width / 2];
    expect(bottom).toBe(0);
  });

  test("a matte of a wider region than the crop is read at the crop's place in it", () => {
    const data = new Uint8Array(8 * 1);
    data[6] = 255; // only the seventh of eight columns
    const canvasMatte = canvasMatteFromRegionMask({
      matte: { width: 8, height: 1, data, region: { x: 0, y: 0, width: 1920, height: 1080 } },
      crop: { x: 1440, y: 0, width: 480, height: 1080 }, // columns 6 and 7 of the matte
      destination: { x: 0, y: 0, width: 1080, height: 1920 },
      canvas: CANVAS,
    });
    expect(captionMatteColumnTop(canvasMatte, CANVAS, 100)).toBe(0);
    expect(captionMatteColumnTop(canvasMatte, CANVAS, 1000)).toBeNull();
  });
});
