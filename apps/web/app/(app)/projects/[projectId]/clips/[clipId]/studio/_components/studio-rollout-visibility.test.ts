import { describe, expect, test } from "bun:test";

import {
  availableAutoCensorTreatments,
  availableSceneMotionValues,
  availableStudioTransitions,
  boundedAutoCensorPreview,
  hasManualBrollTarget,
} from "./studio-rollout-visibility";

describe("Studio rollout visibility", () => {
  test("shows only released censor treatments", () => {
    expect(
      availableAutoCensorTreatments({
        scan: true,
        captionMask: true,
        mute: false,
        beep: false,
      }),
    ).toEqual(["caption_mask"]);
  });

  test("bounds Free scan previews while leaving paid review complete", () => {
    const suggestions = Array.from({ length: 14 }, (_, index) => index);

    expect(boundedAutoCensorPreview(suggestions, false, 10)).toEqual(
      suggestions.slice(0, 10),
    );
    expect(boundedAutoCensorPreview(suggestions, true, 10)).toEqual(
      suggestions,
    );
  });

  test("keeps a saved transition visible while hiding unreleased choices", () => {
    const rollout = {
      legacyTransitions: true,
      crossDissolve: true,
      directionalWipe: true,
      directionalSlide: false,
      zoom: false,
      mediaFadeScale: false,
      panKenBurns: false,
      campaignApply: false,
    };

    expect(availableStudioTransitions(rollout, "slide-left")).toContain(
      "slide-left",
    );
    expect(availableStudioTransitions(rollout, "none")).not.toContain(
      "slide-left",
    );
    expect(availableStudioTransitions(rollout, "none")).toContain(
      "wipe-down",
    );
  });

  test("keeps saved media motion removable after its family is paused", () => {
    const rollout = {
      legacyTransitions: true,
      crossDissolve: true,
      directionalWipe: true,
      directionalSlide: true,
      zoom: true,
      mediaFadeScale: true,
      panKenBurns: false,
      campaignApply: false,
    };

    expect(availableSceneMotionValues(rollout, "entrance", "pan-left")).toContain(
      "pan-left",
    );
    expect(availableSceneMotionValues(rollout, "entrance", "none")).not.toContain(
      "pan-left",
    );
    expect(availableSceneMotionValues(rollout, "exit", "none")).toEqual([
      "none",
      "fade",
      "scale-out",
    ]);
  });

  test("offers the aggregate B-roll motion target for bounded placements", () => {
    expect(hasManualBrollTarget(null, [])).toBe(false);
    expect(hasManualBrollTarget("https://media.example.test/manual.mp4", [])).toBe(
      true,
    );
    expect(hasManualBrollTarget(null, [{ id: "placement" }])).toBe(true);
  });
});
