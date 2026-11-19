import { describe, expect, test } from "bun:test";
import { CAPTION_MOTIONS, captionEaseProgress, captionEntranceKeyframes, captionEntranceTimeScale } from "@narriflow/validators";
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

  test("blur and bounce fade in linearly, as the worker's one \\fade does, while blur and scale keep their ease", () => {
    const blur = CAPTION_MOTIONS.blur.word;
    const fading = captionBlockWordPose(blur, 70, 1);
    expect(fading.opacity).toBeCloseTo(70 / 280, 9);
    expect(fading.blurEm).toBeCloseTo(0.12 * (1 - captionEaseProgress("out", 70 / 280)), 9);
    const bounce = CAPTION_MOTIONS.bounce.word;
    const growing = captionBlockWordPose(bounce, 82.5, 1);
    expect(growing.opacity).toBeCloseTo(0.5, 9);
    expect(growing.scaleX).toBeCloseTo(0.4 + (1.18 - 0.4) * captionEaseProgress("out", 0.5), 9);
    // The duration cap stretches the same linear fade.
    expect(captionBlockWordPose(blur, 35, 0.5).opacity).toBeCloseTo(fading.opacity, 9);
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

  test("scales about the element's own scale origin, as libass scales an event about its \\pos", () => {
    const pose = { ...captionBlockWordPose(word, 1000, 1), scaleX: 1.25, scaleY: 1.25 };
    expect(captionBlockTransform(pose, { rotationDeg: 2, motionSign: 1, emPx: 100 }, 20000, { x: 0, y: -12 })).toBe(
      "rotate(2deg) translate(0px, 0px) translate(0px, -12px) scale(1.25, 1.25) translate(0px, 12px)",
    );
    // At rest the origin changes nothing, so it is left out.
    expect(captionBlockTransform({ ...pose, scaleX: 1, scaleY: 1 }, { rotationDeg: 2, motionSign: 1, emPx: 100 }, 20000, { x: 0, y: -12 })).toBe(
      "rotate(2deg) translate(0px, 0px) scale(1, 1)",
    );
  });

  test("drop turns the word about its centre while it falls", () => {
    const drop = captionEntranceKeyframes(CAPTION_MOTIONS.drop, false);
    const pose = captionBlockWordPose(drop, 60, 1);
    expect(pose.rotateZDeg).toBeCloseTo(-2, 9);
    expect(pose.offsetYEm).toBeCloseTo(-0.1, 9);
    expect(captionBlockTransform(pose, { rotationDeg: 1.5, motionSign: 1, emPx: 100 }, 20000)).toBe(
      `rotate(${1.5 + pose.rotateZDeg}deg) translate(0px, ${pose.offsetYEm * 100}px) scale(1, 1)`,
    );
  });

  test("adds the classic flip camera only for a rotateX pose", () => {
    const flip = { ...captionBlockWordPose(word, 1000, 1), rotateXDeg: 30 };
    expect(captionBlockTransform(flip, { rotationDeg: 0, motionSign: 1, emPx: 50 }, 7000)).toBe(
      "rotate(0deg) translate(0px, 0px) perspective(7000px) rotateX(30deg) scale(1, 1)",
    );
  });
});

/** Applies a CSS transform string (rotate/translate/scale only) to a point given relative to the transform origin. */
function applyTransform(transform: string, point: { x: number; y: number }) {
  const ops = [...transform.matchAll(/(rotate|translate|scale)\(([^)]*)\)/g)].map(([, name, args]) => ({
    name: name!,
    values: args!.split(",").map((value) => Number.parseFloat(value)),
  }));
  let { x, y } = point;
  // CSS applies the listed functions right to left to a point.
  for (const op of ops.reverse()) {
    if (op.name === "translate") {
      x += op.values[0]!;
      y += op.values[1]!;
    } else if (op.name === "scale") {
      x *= op.values[0]!;
      y *= op.values[1] ?? op.values[0]!;
    } else {
      const theta = (op.values[0]! * Math.PI) / 180;
      [x, y] = [x * Math.cos(theta) - y * Math.sin(theta), x * Math.sin(theta) + y * Math.cos(theta)];
    }
  }
  return { x, y };
}

describe("scale pivot (05b finding 3)", () => {
  test("a slam hero grows about its scale origin, travels, then turns about its centre, as libass draws an \\an5 event", () => {
    const hero = captionEntranceKeyframes(CAPTION_MOTIONS.slam, true);
    const pose = captionBlockWordPose(hero, 33, 1);
    expect(pose.scaleX).toBeGreaterThan(1.05);
    // A word turned 1.5 degrees whose line-box middle sits 30 px above its ink centre.
    const word = { rotationDeg: 1.5, motionSign: 1 as const, emPx: 200 };
    const origin = { x: 0, y: -30 };
    const transform = captionBlockTransform(pose, word, 20000, origin);
    for (const point of [{ x: -120, y: -60 }, { x: 140, y: 45 }, { x: 0, y: 0 }]) {
      // libass: scale about \\pos (the scale origin), move, then turn about \\org (the centre).
      const sx = origin.x + (point.x - origin.x) * pose.scaleX;
      const sy = origin.y + (point.y - origin.y) * pose.scaleY;
      const tx = sx + pose.offsetXEm * word.emPx;
      const ty = sy + pose.offsetYEm * word.emPx;
      const theta = ((word.rotationDeg + pose.rotateZDeg) * Math.PI) / 180;
      const want = { x: tx * Math.cos(theta) - ty * Math.sin(theta), y: tx * Math.sin(theta) + ty * Math.cos(theta) };
      const got = applyTransform(transform, point);
      expect(got.x).toBeCloseTo(want.x, 6);
      expect(got.y).toBeCloseTo(want.y, 6);
    }
    // Scaling about the ink centre instead would put the word's top edge elsewhere.
    const naive = applyTransform(captionBlockTransform(pose, word, 20000), { x: 0, y: -60 });
    expect(Math.abs(naive.y - applyTransform(transform, { x: 0, y: -60 }).y)).toBeGreaterThan(1);
  });
});
