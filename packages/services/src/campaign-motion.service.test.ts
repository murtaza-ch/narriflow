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
const placementId = "20000000-0000-4000-8000-000000000003";

function brollPlacement(
	id = placementId,
	startSec = 1,
	endSec = 4,
) {
	return {
		id,
		asset: {
			kind: "visual_asset" as const,
			id: id === placementId
				? "20000000-0000-4000-8000-000000000004"
				: "20000000-0000-4000-8000-000000000007",
			fingerprint: "a".repeat(64),
		},
		provenance: "generated" as const,
		mediaKind: "image" as const,
		startSec,
		endSec,
		sourceStartSec: null,
		sourceEndSec: null,
	};
}

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

	test("applies motion to the current URL-backed manual B-roll target", () => {
    const planned = applyCampaignMotionChange(
		document({
			clipStartSec: 0,
			clipEndSec: 20,
			brollUrl: "https://media.example.test/manual.mp4",
			brollPlacements: [],
		}),
      {
        scope: "manual_broll",
        motion: { entrance: "fade", exit: "scale-out" },
      },
		() => replacementMotionId,
    );
		expect(planned.status).toBe("changed");
		if (planned.status !== "changed") throw new Error("expected a changed plan");
		expect(planned.document.mediaMotions).toEqual([{
			schemaVersion: 1,
			id: replacementMotionId,
			target: { kind: "broll_url" },
			startSec: 5.6,
			endSec: 9.1,
			entrance: "fade",
			exit: "scale-out",
			enabled: true,
		}]);
	});

	test("marks manual B-roll motion ineligible when neither target contract exists", () => {
		const planned = applyCampaignMotionChange(
			document({ brollUrl: null, brollPlacements: [] }),
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

  test("applies one exact-range motion to every asset-backed B-roll placement", () => {
    const secondMotionId = "20000000-0000-4000-8000-000000000005";
    const secondPlacementId = "20000000-0000-4000-8000-000000000006";
    const current = document({
      brollUrl: null,
      brollPlacements: [
		brollPlacement(),
		brollPlacement(secondPlacementId, 6, 9),
      ],
    });
	let createCount = 0;
    const planned = applyCampaignMotionChange(
      current,
      {
        scope: "manual_broll",
        motion: { entrance: "fade", exit: "scale-out" },
      },
		() => [replacementMotionId, secondMotionId][createCount++]!,
    );

    expect(planned.status).toBe("changed");
    if (planned.status !== "changed") throw new Error("expected a changed plan");
    expect(planned.document.mediaMotions).toEqual([
      {
        schemaVersion: 1,
        id: replacementMotionId,
		target: { kind: "broll", placementId },
		startSec: 1,
		endSec: 4,
        entrance: "fade",
        exit: "scale-out",
        enabled: true,
      },
	  {
		schemaVersion: 1,
		id: secondMotionId,
		target: { kind: "broll", placementId: secondPlacementId },
		startSec: 6,
		endSec: 9,
		entrance: "fade",
		exit: "scale-out",
		enabled: true,
	  },
    ]);
  });

  test("replaces a placement motion in place without changing its target or range", () => {
    const current = document({
		brollPlacements: [brollPlacement()],
      mediaMotions: [
        {
          schemaVersion: 1,
          id: existingMotionId,
			target: { kind: "broll", placementId },
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
		target: { kind: "broll", placementId },
		startSec: 1,
		endSec: 4,
        entrance: "ken-burns-in",
        exit: "pan-left",
        enabled: true,
      },
    ]);
  });

  test("treats none / none as an idempotent clear", () => {
    const current = document({
		brollPlacements: [brollPlacement()],
      mediaMotions: [
        {
          schemaVersion: 1,
          id: existingMotionId,
			target: { kind: "broll", placementId },
			startSec: 1,
			endSec: 4,
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
