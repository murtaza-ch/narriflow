import { describe, expect, test } from "bun:test";
import {
  mediaMotionReleased,
  SCENE_MOTION_ENTRANCES,
  SCENE_MOTION_EXITS,
  STUDIO_TRANSITION_TYPES,
  transitionMotionReleased,
  type MotionReleaseState,
} from "./motion-policy";

const rollout: MotionReleaseState = {
  legacyTransitions: true,
  crossDissolve: false,
  directionalWipe: true,
  directionalSlide: false,
  zoom: true,
  mediaFadeScale: false,
  panKenBurns: true,
};

describe("motion release policy", () => {
  test("classifies every transition through one release-family policy", () => {
    expect(
      STUDIO_TRANSITION_TYPES.filter((value) =>
        transitionMotionReleased(value, rollout),
      ),
    ).toEqual([
      "none",
      "fade",
      "fade-black",
      "dip-white",
      "wipe-left",
      "wipe-right",
      "wipe-up",
      "wipe-down",
      "zoom-in",
      "zoom-out",
    ]);
  });

  test("classifies every entrance and exit through the same media-family policy", () => {
    expect(
      SCENE_MOTION_ENTRANCES.filter((value) =>
        mediaMotionReleased(value, rollout),
      ),
    ).toEqual([
      "none",
      "pan-left",
      "pan-right",
      "pan-up",
      "pan-down",
      "ken-burns-in",
    ]);
    expect(
      SCENE_MOTION_EXITS.filter((value) => mediaMotionReleased(value, rollout)),
    ).toEqual([
      "none",
      "pan-left",
      "pan-right",
      "pan-up",
      "pan-down",
      "ken-burns-out",
    ]);
  });

  test("fails closed for an unrecognized value at an untyped boundary", () => {
    expect(transitionMotionReleased("spin" as never, rollout)).toBe(false);
    expect(mediaMotionReleased("bounce" as never, rollout)).toBe(false);
  });
});
