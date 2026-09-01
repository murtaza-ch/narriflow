import { describe, expect, test } from "bun:test";

import {
  applyMotionSelectedSchema,
  campaignOperationActionSchema,
} from "./campaign-operation";

const clipId = "10000000-0000-4000-8000-000000000001";

describe("selection-scoped campaign operation schemas", () => {
  test("accepts Studio transition and B-roll motion values without translation", () => {
    expect(
      applyMotionSelectedSchema.parse({
        change: {
          scope: "clip_transition",
          transition: { type: "fade-black", durationSec: 0.4 },
        },
        clips: [{ clipId, expectedEditorRevision: 7 }],
      }).change,
    ).toEqual({
      scope: "clip_transition",
      transition: { type: "fade-black", durationSec: 0.4 },
    });

    expect(
      applyMotionSelectedSchema.parse({
        change: {
          scope: "manual_broll",
          motion: { entrance: "ken-burns-in", exit: "pan-left" },
        },
        clips: [{ clipId, expectedEditorRevision: 7 }],
      }).change,
    ).toEqual({
      scope: "manual_broll",
      motion: { entrance: "ken-burns-in", exit: "pan-left" },
    });
  });

  test("rejects arbitrary patches and duplicate clip revision fences", () => {
    expect(
      applyMotionSelectedSchema.safeParse({
        change: { scope: "arbitrary_patch", patch: { captionPreset: {} } },
        clips: [{ clipId, expectedEditorRevision: 1 }],
      }).success,
    ).toBe(false);
    expect(
      applyMotionSelectedSchema.safeParse({
        change: {
          scope: "clip_transition",
          transition: { type: "fade", durationSec: 0.4 },
        },
        clips: [
          { clipId, expectedEditorRevision: 1 },
          { clipId, expectedEditorRevision: 2 },
        ],
      }).success,
    ).toBe(false);
  });

  test("registers style and motion in the durable action vocabulary", () => {
    expect(campaignOperationActionSchema.parse("apply_style")).toBe(
      "apply_style",
    );
    expect(campaignOperationActionSchema.parse("apply_motion")).toBe(
      "apply_motion",
    );
  });
});
