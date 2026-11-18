import { describe, expect, test } from "bun:test";
import {
  CAPTION_MOTIONS,
  CAPTION_PILL,
  captionEaseProgress,
  captionEntranceKeyframes,
  captionEntranceMs,
  captionEntranceTimeScale,
  captionKeyframeValue,
  captionTypewriterLetterDelays,
  type CaptionKeyframe,
  type CaptionMotionSpec,
} from ".";

const motions: [string, CaptionMotionSpec][] = Object.entries(CAPTION_MOTIONS);
/** Every keyframe track a renderer plays: each motion's word track and, when present, its hero track. */
const tracks: [string, readonly CaptionKeyframe[]][] = motions.flatMap(([name, spec]) => [
  [`${name}.word`, spec.word] as [string, readonly CaptionKeyframe[]],
  ...(spec.hero ? [[`${name}.hero`, spec.hero] as [string, readonly CaptionKeyframe[]]] : []),
]);

describe("caption motion spec", () => {
  test("keyframes are in time order", () => {
    for (const [, track] of tracks) {
      const times = track.map((frame) => frame.at);
      expect(times).toEqual([...times].sort((left, right) => left - right));
    }
  });

  test("position tracks fit one linear libass \\move: x and y travel share one window", () => {
    for (const [name, track] of tracks) {
      const x = track.filter((frame) => frame.offsetXEm !== undefined);
      const y = track.filter((frame) => frame.offsetYEm !== undefined);
      expect({ name, x: x.length <= 2, y: y.length <= 2 }).toEqual({ name, x: true, y: true });
      for (const frame of [...x, ...y]) expect(frame.ease ?? "linear").toBe("linear");
      if (x.length > 0 && y.length > 0) expect({ name, window: x.map((frame) => frame.at) }).toEqual({ name, window: y.map((frame) => frame.at) });
    }
  });

  test("opacity tracks only rise, so one libass \\fade can render them", () => {
    for (const [, track] of [...tracks, ["pill", CAPTION_PILL.enter] as const]) {
      const values = track
        .filter((frame: CaptionKeyframe) => frame.opacity !== undefined)
        .map((frame: CaptionKeyframe) => frame.opacity!);
      expect(values).toEqual([...values].sort((left, right) => left - right));
    }
  });

  test("word-reveal motions keep upcoming words hidden and enter from transparent", () => {
    for (const [, spec] of motions) {
      if (spec.reveal !== "word") continue;
      expect(spec.upcomingOpacity).toBe(0);
      for (const track of [spec.word, spec.hero ?? []]) {
        if (track.length > 0) expect(captionKeyframeValue(track, "opacity", 0)).toBe(0);
      }
    }
  });

  test("every track settles at rest: no offset, rotation or blur, full scale", () => {
    for (const [name, track] of tracks) {
      const end = captionEntranceMs(track) + 1;
      for (const property of ["offsetXEm", "offsetYEm", "rotateZDeg", "blurEm"] as const) {
        expect({ name, property, value: captionKeyframeValue(track, property, end) ?? 0 }).toEqual({ name, property, value: 0 });
      }
      for (const property of ["scaleX", "scaleY", "opacity"] as const) {
        expect({ name, property, value: captionKeyframeValue(track, property, end) ?? 1 }).toEqual({ name, property, value: 1 });
      }
    }
  });

  test("slide: support words travel in from the side, the hero rises with the only blur", () => {
    const slide = CAPTION_MOTIONS.slide;
    expect(slide.reveal).toBe("word");
    expect(captionKeyframeValue(slide.word, "offsetXEm", 0)).toBe(-0.18);
    expect(captionKeyframeValue(slide.word, "offsetXEm", 45)).toBeCloseTo(-0.09, 6);
    expect(captionKeyframeValue(slide.word, "opacity", 40)).toBe(1);
    expect(captionKeyframeValue(slide.word, "blurEm", 0)).toBeUndefined();
    expect(captionEntranceMs(slide.word)).toBe(90);
    expect(captionKeyframeValue(slide.hero, "offsetYEm", 75)).toBeCloseTo(0.06, 6);
    expect(captionKeyframeValue(slide.hero, "blurEm", 25)).toBeCloseTo(0.04 * (1 - captionEaseProgress("out", 0.25)), 6);
    expect(captionKeyframeValue(slide.hero, "opacity", 40)).toBe(1);
    expect(captionEntranceMs(slide.hero)).toBe(150);
  });

  test("hero words fall back to the word track when a motion has no hero track", () => {
    expect(captionEntranceKeyframes(CAPTION_MOTIONS.rise, true)).toBe(CAPTION_MOTIONS.rise.word);
    expect(captionEntranceKeyframes(CAPTION_MOTIONS.slide, true)).toBe(CAPTION_MOTIONS.slide.hero);
    expect(captionEntranceKeyframes(CAPTION_MOTIONS.slide, false)).toBe(CAPTION_MOTIONS.slide.word);
  });
});

describe("captionEntranceTimeScale (duration cap, spec 5.7)", () => {
  test("an entrance uses at most 45% of the cue time left at the word's onset", () => {
    expect(captionEntranceTimeScale(1000, 150)).toBe(1);
    expect(captionEntranceTimeScale(200, 150)).toBeCloseTo(0.6, 9);
    expect(captionEntranceTimeScale(300, 150)).toBeCloseTo(0.9, 9);
    expect(captionEntranceTimeScale(1000 / 3, 150)).toBeCloseTo(1, 9);
  });

  test("less than 100 ms of cue left, or no entrance, draws the word settled", () => {
    expect(captionEntranceTimeScale(99, 90)).toBe(0);
    expect(captionEntranceTimeScale(100, 90)).toBeCloseTo(0.5, 9);
    expect(captionEntranceTimeScale(500, 0)).toBe(0);
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
