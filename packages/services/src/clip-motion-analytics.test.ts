import { describe, expect, test } from "bun:test";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import { motionRenderAnalyticsMetadata } from "./clip.service";

describe("motion render analytics", () => {
  test("records only bounded motion classifications and counts", () => {
    const document = editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 0,
      clipEndSec: 3,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({
        transition: { type: "wipe-left", durationSec: 0.3 },
      }),
      brollUrl: null,
      deletedRanges: [],
      mediaMotions: [{
        schemaVersion: 1,
        id: "50000000-0000-4000-8000-000000000001",
        target: { kind: "broll" },
        startSec: 0,
        endSec: 3,
        entrance: "pan-left",
        exit: "ken-burns-out",
        durationSec: 0.8,
        enabled: true,
      }],
    });

    expect(motionRenderAnalyticsMetadata(document, {
      applyScope: "selected",
      fallbackCodes: ["scene_motion_entrance_suppressed_by_transition"],
      renderOutcome: "failed",
    })).toEqual({
      motionFamily: ["media:ken-burns-out", "media:pan-left", "transition:wipe-left"],
      durationBucket: "long",
      targetCount: 2,
      applyScope: "selected",
      fallbackCode: ["scene_motion_entrance_suppressed_by_transition"],
      renderOutcome: "failed",
    });
  });
});
