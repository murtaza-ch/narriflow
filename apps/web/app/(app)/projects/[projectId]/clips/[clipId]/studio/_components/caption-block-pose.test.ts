import { describe, expect, test } from "bun:test";
import { CAPTION_MOTIONS, captionEntranceKeyframes, captionEntranceTimeScale } from "@narriflow/validators";
import { captionBlockTransform, captionBlockWordPose } from "./caption-block-pose";

const slide = CAPTION_MOTIONS.slide;
const word = captionEntranceKeyframes(slide, false);
const hero = captionEntranceKeyframes(slide, true);

describe("captionBlockWordPose (spec 5.7)", () => {
  test("samples the export's keyframes from the time since the word's onset", () => {
    const onset = captionBlockWordPose(hero, 0, 1);
    expect(onset.opacity).toBe(0);
    expect(onset.offsetYEm).toBeCloseTo(0.12, 9);
    expect(onset.blurEm).toBeCloseTo(0.04, 9);
    // 100 ms in: opacity is full (by 40 ms), the blur has ended, the linear rise is a third from home.
    const mid = captionBlockWordPose(hero, 100, 1);
    expect(mid.opacity).toBe(1);
    expect(mid.blurEm).toBe(0);
    expect(mid.offsetYEm).toBeCloseTo(0.12 * (50 / 150), 9);
    const sideways = captionBlockWordPose(word, 45, 1);
    expect(sideways.offsetXEm).toBeCloseTo(-0.18 * (45 / 90), 9);
  });

  test("is a pure function of time: a seek lands on the pose playback reaches", () => {
    const played = [0, 16, 33, 66, 100].map((ms) => captionBlockWordPose(hero, ms, 1));
    const sought = [100, 0, 66, 16, 33].map((ms) => captionBlockWordPose(hero, ms, 1));
    expect(sought[0]).toEqual(played[4]!);
    expect(sought[1]).toEqual(played[0]!);
    expect(sought[2]).toEqual(played[3]!);
  });

  test("the duration cap scales keyframe times; 0 and reduced motion draw the word settled", () => {
    const half = captionBlockWordPose(hero, 50, 0.5);
    expect(half.offsetYEm).toBeCloseTo(captionBlockWordPose(hero, 100, 1).offsetYEm, 9);
    const settled = { opacity: 1, offsetXEm: 0, offsetYEm: 0, scaleX: 1, scaleY: 1, blurEm: 0, rotateZDeg: 0, rotateXDeg: 0 };
    expect(captionBlockWordPose(hero, 0, 0)).toEqual(settled);
    expect(captionBlockWordPose(word, 10, 0)).toEqual(settled);
    // With under 100 ms of the cue left the shared cap is 0.
    expect(captionEntranceTimeScale(90, 150)).toBe(0);
  });

  test("holds before the onset and after the entrance", () => {
    expect(captionBlockWordPose(hero, -20, 1)).toEqual(captionBlockWordPose(hero, 0, 1));
    expect(captionBlockWordPose(hero, 5000, 1).offsetYEm).toBe(0);
  });
});

describe("captionBlockTransform", () => {
  test("rotate, then screen-space travel scaled by the word's size and motion sign, then scale", () => {
    const pose = { ...captionBlockWordPose(word, 0, 1), scaleX: 1.1, scaleY: 0.9 };
    expect(captionBlockTransform(pose, { rotationDeg: -2, motionSign: -1, emPx: 100 }, 20000)).toBe(
      "rotate(-2deg) translate(18px, 0px) scale(1.1, 0.9)",
    );
  });

  test("adds the classic flip camera only for a rotateX pose", () => {
    const flip = { ...captionBlockWordPose(word, 1000, 1), rotateXDeg: 30 };
    expect(captionBlockTransform(flip, { rotationDeg: 0, motionSign: 1, emPx: 50 }, 7000)).toBe(
      "rotate(0deg) translate(0px, 0px) perspective(7000px) rotateX(30deg) scale(1, 1)",
    );
  });
});
