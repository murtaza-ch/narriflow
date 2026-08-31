import { describe, expect, test } from "bun:test";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
} from "@narriflow/validators";

import {
  editorDocumentFeatureMutationError,
  studioMotionPatchFeatureError,
} from "./editor-document-feature-policy";

const censorId = "57e59b57-3f0e-4f1c-9617-43b85cc02114";
const motionId = "9d1eae40-6a82-44f1-8f11-c1ecbe381f27";
const sceneId = "f95f9c39-06c3-4768-a488-673064b7e631";
const placementId = "2adf79cc-35b2-4de5-85dc-c9ed197763e4";

const brollPlacement = {
	id: placementId,
	asset: {
		kind: "visual_asset" as const,
		id: "8ab9d330-688f-4574-932c-27ac661245c1",
		fingerprint: "a".repeat(64),
	},
	provenance: "uploaded" as const,
	mediaKind: "image" as const,
	startSec: 0,
	endSec: 5,
	sourceStartSec: null,
	sourceEndSec: null,
};

function document(overrides: Partial<EditorDocument> = {}): EditorDocument {
  return editorDocumentSchema.parse({
    version: 2,
    clipStartSec: 0,
    clipEndSec: 5,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: "https://media.example.test/cutaway.mp4",
    deletedRanges: [],
    ...overrides,
  });
}

const censorSegment = {
  schemaVersion: 1 as const,
  id: censorId,
  sourceWordIds: ["word:0:0:aabbccdd"],
  sourceStartSec: 1,
  sourceEndSec: 1.3,
  treatment: "beep" as const,
  paddingSec: 0.08,
  beepSettings: { frequencyHz: 1_000, levelDb: -12 },
  captionMaskPolicy: null,
  suggestionFingerprint: "a".repeat(32),
  policyVersion: "auto-censor:test:v1",
  enabled: true,
};

const mediaMotion = {
  schemaVersion: 1 as const,
  id: motionId,
	target: { kind: "broll" as const, placementId },
  startSec: 0,
  endSec: 5,
  entrance: "pan-left" as const,
  exit: "scale-out" as const,
  enabled: true,
};

const scene = {
  schemaVersion: 1 as const,
  id: sceneId,
  anchorSec: 0,
  durationSec: 1,
  content: { kind: "color" as const, color: "#112233" },
  motion: { entrance: "fade" as const, exit: "scale-out" as const },
  templateSnapshot: null,
};

describe("editorDocumentFeatureMutationError", () => {
  test("rejects paid censor state introduced or altered by a Free save", () => {
    const current = document();
    const added = document({ censorSegments: [censorSegment] });
    expect(editorDocumentFeatureMutationError("free", current, added)).toEqual({
      status: 403,
      error: "auto_censor_feature_unavailable",
      message: "Saving censor treatments is not available on this plan",
    });

    const existing = document({ censorSegments: [censorSegment] });
    const altered = document({
      censorSegments: [
        { ...censorSegment, beepSettings: { frequencyHz: 900, levelDb: -12 } },
      ],
    });
    expect(editorDocumentFeatureMutationError("free", existing, altered)?.error)
      .toBe("auto_censor_feature_unavailable");
  });

  test("allows a downgraded editor to disable or remove existing censor state", () => {
    const current = document({ censorSegments: [censorSegment] });
    expect(
      editorDocumentFeatureMutationError(
        "free",
        current,
        document({ censorSegments: [{ ...censorSegment, enabled: false }] }),
      ),
    ).toBeNull();
    expect(
      editorDocumentFeatureMutationError(
        "free",
        current,
        document({ censorSegments: [] }),
      ),
    ).toBeNull();
  });

  test("rejects a direct treatment write when its Auto Censor stage is closed", () => {
    const current = document();
    const next = document({ censorSegments: [censorSegment] });

    expect(
      editorDocumentFeatureMutationError("creator", current, next, {
        autoCensor: {
          scan: true,
          captionMask: true,
          mute: true,
          beep: false,
          freePreviewLimit: 10,
        },
      }),
    ).toEqual({
      status: 503,
      error: "auto_censor_rollout_unavailable",
      message: "This censor treatment is temporarily read-only",
    });

    expect(
      editorDocumentFeatureMutationError(
        "creator",
        document({ censorSegments: [censorSegment] }),
        document({ censorSegments: [{ ...censorSegment, enabled: false }] }),
        {
          autoCensor: {
            scan: false,
            captionMask: false,
            mute: false,
            beep: false,
            freePreviewLimit: 10,
          },
        },
      ),
    ).toBeNull();
  });

  test("rejects paid transition, media, and Scene motion introduced by a Free save", () => {
    const current = document({ sceneBlocks: [{ ...scene, motion: { entrance: "none", exit: "none" } }] });
    const transition = document({
      sceneBlocks: current.sceneBlocks,
      studioEdits: studioEditsSchema.parse({
        ...current.studioEdits,
        transition: { type: "wipe-left", durationSec: 0.4 },
      }),
    });
    expect(editorDocumentFeatureMutationError("free", current, transition)).toEqual({
      status: 403,
      error: "motion_feature_unavailable",
      message: "Saving motion is not available on this plan",
    });
    expect(
      editorDocumentFeatureMutationError(
        "free",
        current,
		document({
			brollPlacements: [brollPlacement],
			sceneBlocks: current.sceneBlocks,
			mediaMotions: [mediaMotion],
		}),
      )?.error,
    ).toBe("motion_feature_unavailable");
    expect(
      editorDocumentFeatureMutationError(
        "free",
        current,
        document({ sceneBlocks: [scene] }),
      )?.error,
    ).toBe("motion_feature_unavailable");
  });

  test("allows safe motion removal after downgrade and all paid-plan changes", () => {
    const current = document({
      studioEdits: studioEditsSchema.parse({
        transition: { type: "zoom-in", durationSec: 0.4 },
      }),
		brollPlacements: [brollPlacement],
      mediaMotions: [mediaMotion],
      sceneBlocks: [scene],
    });
    const disabled = document({
      studioEdits: studioEditsSchema.parse({
        ...current.studioEdits,
        transition: { type: "none", durationSec: 0.4 },
      }),
		brollPlacements: [brollPlacement],
      mediaMotions: [{ ...mediaMotion, enabled: false }],
      sceneBlocks: [{ ...scene, motion: { entrance: "none", exit: "none" } }],
    });
    expect(editorDocumentFeatureMutationError("free", current, disabled)).toBeNull();
    expect(
      editorDocumentFeatureMutationError("creator", document(), current, {
        motion: {
          legacyTransitions: true,
          crossDissolve: true,
          directionalWipe: true,
          directionalSlide: true,
          zoom: true,
          mediaFadeScale: true,
          panKenBurns: true,
          campaignApply: true,
        },
      }),
    ).toBeNull();
  });

  test("rejects a direct transition write when its Motion family is closed", () => {
    const rollout = {
      motion: {
        legacyTransitions: true,
        crossDissolve: false,
        directionalWipe: false,
        directionalSlide: false,
        zoom: false,
        mediaFadeScale: false,
        panKenBurns: false,
        campaignApply: false,
      },
    };
    const current = document();
    const next = document({
      studioEdits: studioEditsSchema.parse({
        transition: { type: "cross-dissolve", durationSec: 0.4 },
      }),
    });

    expect(
      editorDocumentFeatureMutationError("creator", current, next, rollout),
    ).toEqual({
      status: 503,
      error: "motion_rollout_unavailable",
      message: "This motion family is temporarily read-only",
    });
    expect(
      editorDocumentFeatureMutationError("creator", next, current, rollout),
    ).toBeNull();
  });

  test("rejects direct media and Scene motion writes when their families are closed", () => {
    const rollout = {
      motion: {
        legacyTransitions: true,
        crossDissolve: true,
        directionalWipe: true,
        directionalSlide: true,
        zoom: true,
        mediaFadeScale: false,
        panKenBurns: false,
        campaignApply: false,
      },
    };

    expect(
      editorDocumentFeatureMutationError(
        "creator",
        document(),
        document({
			brollPlacements: [brollPlacement],
          mediaMotions: [
            {
              ...mediaMotion,
              entrance: "fade",
              exit: "scale-out",
            },
          ],
        }),
        rollout,
      )?.error,
    ).toBe("motion_rollout_unavailable");
    expect(
      editorDocumentFeatureMutationError(
        "creator",
        document({
          sceneBlocks: [
            { ...scene, motion: { entrance: "none", exit: "none" } },
          ],
        }),
        document({ sceneBlocks: [scene] }),
        rollout,
      )?.error,
    ).toBe("motion_rollout_unavailable");
  });

  test("gates apply-to-all motion while preserving static reset and layout patches", () => {
    expect(
      studioMotionPatchFeatureError("free", [
        { transition: { type: "fade", durationSec: 0.4 } },
      ])?.error,
    ).toBe("motion_feature_unavailable");
    expect(
      studioMotionPatchFeatureError("free", [
        { transition: { type: "none", durationSec: 0.4 } },
      ]),
    ).toBeNull();
    expect(
      studioMotionPatchFeatureError("free", [
        { framing: studioEditsSchema.parse({}).framing },
      ]),
    ).toBeNull();
    expect(
      studioMotionPatchFeatureError("creator", [
        { transition: { type: "zoom-out", durationSec: 0.4 } },
      ]),
    ).toEqual({
      status: 503,
      error: "motion_rollout_unavailable",
      message: "This motion family is temporarily read-only",
    });
    expect(
      studioMotionPatchFeatureError(
        "creator",
        [{ transition: { type: "zoom-out", durationSec: 0.4 } }],
        {
          legacyTransitions: true,
          crossDissolve: true,
          directionalWipe: true,
          directionalSlide: true,
          zoom: true,
          mediaFadeScale: true,
          panKenBurns: true,
          campaignApply: true,
        },
      ),
    ).toBeNull();
  });
});
