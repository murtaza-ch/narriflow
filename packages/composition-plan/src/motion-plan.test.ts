import { describe, expect, test } from "bun:test";

import {
  planMediaMotion,
  planTransitionMotion,
  sampleCompositionMotion,
} from "./motion-plan";
import { MOTION_ADAPTER_FIXTURES } from "./motion-plan.fixtures";

const canvas = { width: 1080, height: 1920 };

describe("canonical composition motion", () => {
  test("clamps transition windows and samples exact boundary geometry", () => {
    const motion = planTransitionMotion({
      type: "slide-left",
      durationSec: 0.4,
      activeRange: { startSec: 2, endSec: 2.3 },
      canvas,
    });

    expect(motion.entrance?.range).toEqual({ startSec: 2, endSec: 2.15 });
    expect(motion.exit?.range).toEqual({ startSec: 2.15, endSec: 2.3 });
    expect(sampleCompositionMotion(motion, 2)).toMatchObject({
      transform: { translateX: 1080, translateY: 0, scale: 1 },
    });
    expect(sampleCompositionMotion(motion, 2.15)).toMatchObject({
      transform: { translateX: 0, translateY: 0, scale: 1 },
    });
    expect(sampleCompositionMotion(motion, 2.3)).toMatchObject({
      transform: { translateX: -1080, translateY: 0, scale: 1 },
    });
  });

  test("plans every media family with target-specific integer geometry", () => {
    for (const fixture of MOTION_ADAPTER_FIXTURES.media) {
        const motion = planMediaMotion({
          entrance: fixture.entrance,
          exit: fixture.exit,
          durationSec: fixture.durationSec,
          activeRange: fixture.activeRange,
          canvas: fixture.target,
        });
        for (const state of [motion.restingState, motion.entrance?.from, motion.entrance?.to, motion.exit?.from, motion.exit?.to]) {
          if (!state) continue;
          expect(Object.values(state.crop).every(Number.isInteger)).toBe(true);
          expect(Object.values(state.clip).every(Number.isInteger)).toBe(true);
          expect(Number.isInteger(state.transform.translateX)).toBe(true);
          expect(Number.isInteger(state.transform.translateY)).toBe(true);
        }
    }
  });

  test("reduced-motion sampling keeps content static without mutating the plan", () => {
    const motion = planMediaMotion({
      entrance: "ken-burns-in",
      exit: "fade",
      durationSec: 0.5,
      activeRange: { startSec: 0, endSec: 3 },
      canvas,
    });
    const before = structuredClone(motion);

    expect(sampleCompositionMotion(motion, 0.1, { reducedMotion: true })).toEqual({
      ...motion.restingState,
      reducedMotion: true,
    });
    expect(motion).toEqual(before);
  });
});
