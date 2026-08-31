import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  EDITOR_DOCUMENT_VERSION,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
} from "@narriflow/validators";

import { applyCampaignMotionChange } from "./campaign-operation.service";

const existingMotionId = "20000000-0000-4000-8000-000000000001";
const replacementMotionId = "20000000-0000-4000-8000-000000000002";

function document(overrides: Partial<EditorDocument> = {}): EditorDocument {
  return editorDocumentSchema.parse({
    version: EDITOR_DOCUMENT_VERSION,
    clipStartSec: 10,
    clipEndSec: 20,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: "https://media.example.test/broll.mp4",
    deletedRanges: [],
    sceneBlocks: [],
    censorSegments: [],
    mediaMotions: [],
    ...overrides,
  });
}

describe("applyCampaignMotionChange", () => {
  test("routes transitions through the Studio editor action and preserves every other edit", () => {
    const current = document({
      studioEdits: studioEditsSchema.parse({
        textLayers: [{ id: "title", text: "Keep me" }],
      }),
    });
    const planned = applyCampaignMotionChange(current, {
      scope: "clip_transition",
      transition: { type: "wipe-left", durationSec: 0.65 },
    });

    expect(planned.status).toBe("changed");
    if (planned.status !== "changed") throw new Error("expected a changed plan");
    expect(planned.document.studioEdits.transition).toEqual({
      type: "wipe-left",
      durationSec: 0.65,
    });
    expect(planned.document.studioEdits.textLayers).toEqual(
      current.studioEdits.textLayers,
    );
    expect(current.studioEdits.transition.type).toBe("none");
  });

  test("returns unchanged for an equivalent transition before revision checks", () => {
    const current = document({
      studioEdits: studioEditsSchema.parse({
        transition: { type: "cross-dissolve", durationSec: 0.4 },
      }),
    });

    const planned = applyCampaignMotionChange(current, {
      scope: "clip_transition",
      transition: { type: "cross-dissolve", durationSec: 0.4 },
    });
    expect(planned).toEqual({ status: "unchanged", document: current });
  });

  test("marks manual B-roll motion ineligible when the document has no target", () => {
    const planned = applyCampaignMotionChange(
      document({ brollUrl: null }),
      {
        scope: "manual_broll",
        motion: { entrance: "fade", exit: "scale-out" },
      },
    );
    expect(planned).toEqual({
      status: "ineligible",
      code: "campaign_motion_target_missing",
    });
  });

  test("accepts an asset-backed bounded placement as a manual B-roll target", () => {
    const current = document({
      brollUrl: null,
      brollPlacements: [
        {
          id: "20000000-0000-4000-8000-000000000003",
          asset: {
            kind: "visual_asset",
            id: "20000000-0000-4000-8000-000000000004",
            fingerprint: "a".repeat(64),
          },
          provenance: "generated",
          mediaKind: "image",
          startSec: 1,
          endSec: 4,
          sourceStartSec: null,
          sourceEndSec: null,
        },
      ],
    });
    const planned = applyCampaignMotionChange(
      current,
      {
        scope: "manual_broll",
        motion: { entrance: "fade", exit: "scale-out" },
      },
      () => replacementMotionId,
    );

    expect(planned.status).toBe("changed");
    if (planned.status !== "changed") throw new Error("expected a changed plan");
    expect(planned.document.mediaMotions).toEqual([
      {
        schemaVersion: 1,
        id: replacementMotionId,
        target: { kind: "broll" },
        startSec: 0,
        endSec: 10,
        entrance: "fade",
        exit: "scale-out",
        enabled: true,
      },
    ]);
  });

  test("replaces the one manual B-roll schedule over the exact edited duration", () => {
    const current = document({
      deletedRanges: [{ startSec: 12, endSec: 14 }],
      sceneBlocks: [
        {
          schemaVersion: 1,
          id: "30000000-0000-4000-8000-000000000001",
          anchorSec: 3,
          durationSec: 2,
          content: { kind: "color", color: "#111827" },
          motion: { entrance: "none", exit: "none" },
          templateSnapshot: null,
        },
      ],
      mediaMotions: [
        {
          schemaVersion: 1,
          id: existingMotionId,
          target: { kind: "broll" },
          startSec: 1,
          endSec: 4,
          entrance: "fade",
          exit: "none",
          enabled: true,
        },
      ],
    });
    const planned = applyCampaignMotionChange(
      current,
      {
        scope: "manual_broll",
        motion: { entrance: "ken-burns-in", exit: "pan-left" },
      },
      () => replacementMotionId,
    );

    expect(planned.status).toBe("changed");
    if (planned.status !== "changed") throw new Error("expected a changed plan");
    expect(planned.document.mediaMotions).toEqual([
      {
        schemaVersion: 1,
        id: existingMotionId,
        target: { kind: "broll" },
        startSec: 0,
        // 10s source - 2s deletion + 2s inserted Scene Block.
        endSec: 10,
        entrance: "ken-burns-in",
        exit: "pan-left",
        enabled: true,
      },
    ]);
  });

  test("treats none / none as an idempotent clear", () => {
    const current = document({
      mediaMotions: [
        {
          schemaVersion: 1,
          id: existingMotionId,
          target: { kind: "broll" },
          startSec: 0,
          endSec: 10,
          entrance: "fade",
          exit: "none",
          enabled: true,
        },
      ],
    });
    const change = {
      scope: "manual_broll" as const,
      motion: { entrance: "none" as const, exit: "none" as const },
    };
    const cleared = applyCampaignMotionChange(current, change);
    expect(cleared.status).toBe("changed");
    if (cleared.status !== "changed") throw new Error("expected a changed plan");
    expect(cleared.document.mediaMotions).toEqual([]);
    expect(applyCampaignMotionChange(cleared.document, change).status).toBe(
      "unchanged",
    );
  });
});
