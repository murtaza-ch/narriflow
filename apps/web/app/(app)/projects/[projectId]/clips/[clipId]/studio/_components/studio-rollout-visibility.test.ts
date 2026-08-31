import { describe, expect, test } from "bun:test";

import {
  availableAutoCensorTreatments,
  availableSceneMotionValues,
  availableStudioTransitions,
	brollMotionTargets,
	manualUrlBrollMotionTarget,
  boundedAutoCensorPreview,
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

  test("offers every asset-backed B-roll placement as its own exact-range motion target", () => {
		const placements = [
			{ id: "first", startSec: 1.25, endSec: 3.5, mediaKind: "image" as const },
			{ id: "second", startSec: 5, endSec: 8, mediaKind: "video" as const },
		];
		expect(brollMotionTargets(placements)).toEqual([
			{
				id: "broll:first",
				placementId: "first",
				label: "B-roll 1 · image · 0:01–0:03",
				startSec: 1.25,
				endSec: 3.5,
			},
			{
				id: "broll:second",
				placementId: "second",
				label: "B-roll 2 · video · 0:05–0:08",
				startSec: 5,
				endSec: 8,
			},
		]);
		expect(brollMotionTargets([])).toEqual([]);
  });

	test("offers the one URL-backed manual B-roll target on its canonical window", () => {
		expect(manualUrlBrollMotionTarget(null, 20, false)).toBeNull();
		expect(
			manualUrlBrollMotionTarget(
				"https://media.example.test/manual.mp4",
				20,
				false,
			),
		).toEqual({
			id: "broll:manual-url",
			label: "Manual URL B-roll · 0:05–0:09",
			startSec: 5.6,
			endSec: 9.1,
		});
		expect(
			manualUrlBrollMotionTarget(
				"https://media.example.test/manual.mp4",
				20,
				true,
			),
		).toBeNull();
	});
});
