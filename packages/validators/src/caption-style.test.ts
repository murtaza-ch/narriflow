import { describe, expect, test } from "bun:test";
import {
  CAPTION_MOTIONS,
  CAPTION_PILL,
  captionEaseProgress,
  captionKeyframeValue,
  captionTypewriterLetterDelays,
  type CaptionKeyframe,
} from ".";

const motions = Object.entries(CAPTION_MOTIONS);

describe("caption motion spec", () => {
  test("keyframes are in time order", () => {
    for (const [, spec] of motions) {
      const times = spec.word.map((frame: CaptionKeyframe) => frame.at);
      expect(times).toEqual([...times].sort((left, right) => left - right));
    }
  });

  test("vertical offset tracks fit one linear libass \\move", () => {
    for (const [, spec] of motions) {
      const track = spec.word.filter((frame: CaptionKeyframe) => frame.offsetYEm !== undefined);
      expect(track.length).toBeLessThanOrEqual(2);
      for (const frame of track) expect(frame.ease ?? "linear").toBe("linear");
    }
  });

  test("opacity tracks only rise, so one libass \\fade can render them", () => {
    for (const [, spec] of [...motions, ["pill", { word: CAPTION_PILL.enter }] as const]) {
      const values = spec.word
        .filter((frame: CaptionKeyframe) => frame.opacity !== undefined)
        .map((frame: CaptionKeyframe) => frame.opacity!);
      expect(values).toEqual([...values].sort((left, right) => left - right));
    }
  });

  test("word-reveal motions keep upcoming words hidden and enter from transparent", () => {
    for (const [, spec] of motions) {
      if (spec.reveal !== "word") continue;
      expect(spec.upcomingOpacity).toBe(0);
      if (spec.word.length > 0) expect(captionKeyframeValue(spec.word, "opacity", 0)).toBe(0);
    }
  });
});

describe("captionKeyframeValue", () => {
  const frames: CaptionKeyframe[] = [
    { at: 0, scaleX: 1 },
    { at: 100, scaleX: 2, ease: "out" },
    { at: 200, scaleX: 1 },
  ];

  test("holds the first and last values outside the keyframes", () => {
    expect(captionKeyframeValue(frames, "scaleX", -50)).toBe(1);
    expect(captionKeyframeValue(frames, "scaleX", 500)).toBe(1);
    expect(captionKeyframeValue(frames, "opacity", 50)).toBeUndefined();
  });

  test("follows the libass power curve inside an eased segment", () => {
    expect(captionKeyframeValue(frames, "scaleX", 25)).toBeCloseTo(1 + captionEaseProgress("out", 0.25), 6);
    expect(captionKeyframeValue(frames, "scaleX", 150)).toBeCloseTo(1.5, 6);
  });
});

describe("captionTypewriterLetterDelays", () => {
  test("spaces letters by at most 55 ms and fits them in the word", () => {
    expect(captionTypewriterLetterDelays(4, 1000)).toEqual([0, 55, 110, 165]);
    expect(captionTypewriterLetterDelays(4, 100)).toEqual([0, 25, 50, 75]);
    expect(captionTypewriterLetterDelays(0, 100)).toEqual([]);
  });
});
