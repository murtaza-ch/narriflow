import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  EDITOR_DOCUMENT_VERSION,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";

import { applyCampaignMotionChange } from "./campaign-operation.service";

function document(brollUrl: string | null) {
  return editorDocumentSchema.parse({
    version: EDITOR_DOCUMENT_VERSION,
    clipStartSec: 10,
    clipEndSec: 20,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl,
    deletedRanges: [],
  });
}

describe("selection-scoped campaign motion", () => {
  test("uses the Studio reducer and reports missing B-roll targets", () => {
    const transition = applyCampaignMotionChange(document(null), {
      scope: "clip_transition",
      transition: { type: "fade-black", durationSec: 0.65 },
    });
    expect(transition.status).toBe("changed");
    if (transition.status !== "changed") throw new Error("expected change");
    expect(transition.document.studioEdits.transition).toEqual({
      type: "fade-black",
      durationSec: 0.65,
    });

    expect(
      applyCampaignMotionChange(document(null), {
        scope: "manual_broll",
        motion: { entrance: "fade", exit: "scale-out" },
      }),
    ).toEqual({
      status: "ineligible",
      code: "campaign_motion_target_missing",
    });
  });

  test("replaces the B-roll schedule idempotently and supports clearing it", () => {
    const createId = () => "10000000-0000-4000-8000-000000000001";
    const change = {
      scope: "manual_broll" as const,
      motion: { entrance: "ken-burns-in" as const, exit: "fade" as const },
    };
    const first = applyCampaignMotionChange(document("https://media.test/broll.mp4"), change, createId);
    expect(first.status).toBe("changed");
    if (first.status !== "changed") throw new Error("expected change");
    expect(first.document.mediaMotions).toEqual([
      expect.objectContaining({
        id: "10000000-0000-4000-8000-000000000001",
        target: { kind: "broll" },
        startSec: 0,
        endSec: 10,
        entrance: "ken-burns-in",
        exit: "fade",
      }),
    ]);
    expect(applyCampaignMotionChange(first.document, change, createId)).toEqual({
      status: "unchanged",
      document: first.document,
    });

    const cleared = applyCampaignMotionChange(first.document, {
      scope: "manual_broll",
      motion: { entrance: "none", exit: "none" },
    });
    expect(cleared.status).toBe("changed");
    if (cleared.status !== "changed") throw new Error("expected change");
    expect(cleared.document.mediaMotions).toEqual([]);
  });
});
