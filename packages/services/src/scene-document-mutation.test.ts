import { describe, expect, test } from "bun:test";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
  type SceneBlock,
} from "@narriflow/validators";
import { PlanRequirementError } from "./plan-features";
import {
  analyzeSceneDocumentMutation,
  assertEditorDocumentFeatureDelta,
} from "./scene-document-mutation";

const SCENE_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_SCENE_ID = "10000000-0000-4000-8000-000000000002";
const VISUAL_ASSET_ID = "20000000-0000-4000-8000-000000000001";
const SECOND_VISUAL_ASSET_ID = "20000000-0000-4000-8000-000000000002";
const BROLL_ID = "30000000-0000-4000-8000-000000000001";
const FONT_ID = "40000000-0000-4000-8000-000000000001";

function baseDocument(): EditorDocument {
  return editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 20,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({}),
    brollUrl: null,
    deletedRanges: [],
  });
}

function colorScene(
  id = SCENE_ID,
  overrides: Partial<SceneBlock> = {},
): SceneBlock {
  return {
    schemaVersion: 1,
    id,
    anchorSec: 0,
    durationSec: 3,
    content: { kind: "color", color: "#1D4ED8" },
    motion: { entrance: "none", exit: "none", durationSec: 0.5 },
    templateSnapshot: null,
    ...overrides,
  };
}

function imageScene(id = SCENE_ID, assetId = VISUAL_ASSET_ID): SceneBlock {
  return colorScene(id, {
    content: {
      kind: "image",
      asset: {
        kind: "visual_asset",
        id: assetId,
        fingerprint: "a".repeat(64),
      },
      fit: "cover",
      backgroundColor: "#000000",
    },
  });
}

function textScene(id = SCENE_ID): SceneBlock {
  return colorScene(id, {
    content: {
      kind: "text",
      text: "Opening",
      fontFamily: "Archivo",
      fontAsset: null,
      color: "#FFFFFF",
      backgroundColor: "#000000",
    },
  });
}

describe("analyzeSceneDocumentMutation", () => {
  test("returns no Scene Block work for an unchanged document", () => {
    const current = baseDocument();

    expect(analyzeSceneDocumentMutation(current, current)).toEqual({
      changedSceneBlocks: [],
      introducedSceneReferences: [],
      introducedVisualAssetIds: [],
    });
  });

  test("rejects adding or changing a Scene Block when the workspace lacks the entitlement", () => {
    const current = baseDocument();
    const next = { ...current, sceneBlocks: [colorScene()] };

    expect(() => assertEditorDocumentFeatureDelta("free", current, next)).toThrow(
      PlanRequirementError,
    );
    try {
      assertEditorDocumentFeatureDelta("free", current, next);
    } catch (error) {
      expect(error).toMatchObject({
        code: "plan_feature_required",
        kind: "payment_required",
        details: { feature: "brand.scenes", currentTier: "free", requiredTier: "creator" },
      });
    }
    expect(() =>
      assertEditorDocumentFeatureDelta("free", next, {
        ...next,
        sceneBlocks: [colorScene(SCENE_ID, { durationSec: 4 })],
      }),
    ).toThrow(PlanRequirementError);
  });

  test("lets a downgraded Free workspace delete a Scene Block", () => {
    const current = { ...baseDocument(), sceneBlocks: [colorScene(), imageScene(SECOND_SCENE_ID)] };

    expect(() =>
      assertEditorDocumentFeatureDelta("free", current, { ...current, sceneBlocks: [current.sceneBlocks[0]!] }),
    ).not.toThrow();
    expect(() => assertEditorDocumentFeatureDelta("free", current, baseDocument())).not.toThrow();
  });

  test.each([
    ["scene_cards", colorScene()],
    ["scene_cards", textScene()],
    ["scene_images", imageScene()],
    [
      "scene_videos",
      colorScene(SCENE_ID, {
        content: {
          kind: "video",
          asset: {
            kind: "visual_asset",
            id: VISUAL_ASSET_ID,
            fingerprint: "b".repeat(64),
          },
          sourceStartSec: 0,
          sourceEndSec: 3,
          fit: "cover",
          backgroundColor: "#000000",
          muted: false,
          volume: 100,
        },
      }),
    ],
    [
      "scene_templates",
      colorScene(SCENE_ID, {
        templateSnapshot: {
          templateId: "50000000-0000-4000-8000-000000000001",
          templateRevision: 1,
          fingerprint: "c".repeat(64),
          name: "Opening",
        },
      }),
    ],
  ] as const)("admits entitled %s Scene Blocks without deployment switches", (_group, scene) => {
    const current = baseDocument();
    expect(() => assertEditorDocumentFeatureDelta("creator", current, { ...current, sceneBlocks: [scene] })).not.toThrow();
  });

  test("classifies changed Scene Blocks separately from introduced references", () => {
    const currentScene = imageScene();
    const current = { ...baseDocument(), sceneBlocks: [currentScene] };
    const restyled = {
      ...currentScene,
      content: { ...currentScene.content, fit: "contain" as const },
    };
    const introduced = imageScene(SECOND_SCENE_ID, SECOND_VISUAL_ASSET_ID);
    const next = { ...current, sceneBlocks: [restyled, introduced] };

    const analysis = analyzeSceneDocumentMutation(current, next);

    expect(analysis.changedSceneBlocks).toEqual([restyled, introduced]);
    expect(analysis.introducedSceneReferences).toEqual([introduced]);
  });

  test("lets a downgraded workspace delete Scenes without returning them for reference checks", () => {
    const removed = colorScene();
    const kept = colorScene(SECOND_SCENE_ID, { content: { kind: "color", color: "#000000" } });
    const current = { ...baseDocument(), sceneBlocks: [removed, kept] };
    expect(analyzeSceneDocumentMutation(current, baseDocument()).changedSceneBlocks).toEqual([]);

    expect(() =>
      assertEditorDocumentFeatureDelta("creator", current, baseDocument()),
    ).not.toThrow();
    expect(() =>
      assertEditorDocumentFeatureDelta("free", current, { ...current, sceneBlocks: [kept] }),
    ).not.toThrow();
    // Content that remains and changes is still checked.
    expect(() =>
      assertEditorDocumentFeatureDelta("free", current, {
        ...current,
        sceneBlocks: [{ ...kept, durationSec: 4 }],
      }),
    ).toThrow(PlanRequirementError);
  });

  test("lets a downgraded Free workspace turn a saved Scene's motion off, but not change it otherwise", () => {
    const animated = colorScene(SCENE_ID, { motion: { entrance: "fade", exit: "fade", durationSec: 0.5 } });
    const current = { ...baseDocument(), sceneBlocks: [animated] };
    const stopped = { ...animated, motion: { entrance: "none" as const, exit: "none" as const, durationSec: 0.5 } };

    expect(() =>
      assertEditorDocumentFeatureDelta("free", current, { ...current, sceneBlocks: [stopped] }),
    ).not.toThrow();
    expect(() =>
      assertEditorDocumentFeatureDelta("free", current, { ...current, sceneBlocks: [stopped] }),
    ).not.toThrow();
    expect(() =>
      assertEditorDocumentFeatureDelta("free", current, {
        ...current,
        sceneBlocks: [{ ...stopped, durationSec: 4 }],
      }),
    ).toThrow(PlanRequirementError);
    expect(() =>
      assertEditorDocumentFeatureDelta("free", current, {
        ...current,
        sceneBlocks: [{ ...animated, motion: { entrance: "fade", exit: "none", durationSec: 0.5 } }],
      }),
    ).toThrow(PlanRequirementError);
  });

  test("deduplicates newly introduced visual assets across scenes and B-roll", () => {
    const current = baseDocument();
    const next = editorDocumentSchema.parse({
      ...current,
      sceneBlocks: [
        imageScene(SCENE_ID, VISUAL_ASSET_ID),
        {
          ...imageScene(SECOND_SCENE_ID, VISUAL_ASSET_ID),
          anchorSec: 3,
        },
      ],
      studioEdits: {
        ...current.studioEdits,
        visualBroll: [{
          id: BROLL_ID,
          asset: {
            kind: "visual_asset",
            id: SECOND_VISUAL_ASSET_ID,
            fingerprint: "d".repeat(64),
          },
          startSec: 4,
          endSec: 7,
          fit: "cover",
        }],
      },
    });

    expect(
      analyzeSceneDocumentMutation(current, next)
        .introducedVisualAssetIds,
    ).toEqual([VISUAL_ASSET_ID, SECOND_VISUAL_ASSET_ID]);
  });

  test("returns only the replacement visual asset when a reference changes", () => {
    const current = {
      ...baseDocument(),
      sceneBlocks: [imageScene(SCENE_ID, VISUAL_ASSET_ID)],
    };
    const next = {
      ...current,
      sceneBlocks: [imageScene(SCENE_ID, SECOND_VISUAL_ASSET_ID)],
    };

    expect(
      analyzeSceneDocumentMutation(current, next)
        .introducedVisualAssetIds,
    ).toEqual([SECOND_VISUAL_ASSET_ID]);
  });

  test("does not introduce a visual asset when its reference is removed", () => {
    const current = {
      ...baseDocument(),
      sceneBlocks: [imageScene(SCENE_ID, VISUAL_ASSET_ID)],
    };

    expect(
      analyzeSceneDocumentMutation(current, baseDocument())
        .introducedVisualAssetIds,
    ).toEqual([]);
  });

  test("treats a changed brand-font reference as newly introduced", () => {
    const currentScene = textScene();
    const nextScene = {
      ...currentScene,
      content: {
        ...currentScene.content,
        fontFamily: "Narriflow Sans",
        fontAsset: {
          kind: "brand_font" as const,
          id: FONT_ID,
          fingerprint: "e".repeat(64),
        },
      },
    };
    const current = { ...baseDocument(), sceneBlocks: [currentScene] };

    expect(
      analyzeSceneDocumentMutation(
        current,
        { ...current, sceneBlocks: [nextScene] },
      ).introducedSceneReferences,
    ).toEqual([nextScene]);
  });
});

describe("assertEditorDocumentFeatureDelta motion", () => {
  const transitioned = (document: EditorDocument, type: "fade" | "wipe-left" = "fade") => ({
    ...document,
    studioEdits: { ...document.studioEdits, transition: { type, durationSec: 0.4 } },
  });

  test("gates enabling or changing active motion on Free", () => {
    const current = baseDocument();
    expect(() => assertEditorDocumentFeatureDelta("free", current, transitioned(current))).toThrow(
      expect.objectContaining({ code: "plan_feature_required", details: expect.objectContaining({ feature: "editor.motion" }) }),
    );
    expect(() => assertEditorDocumentFeatureDelta("creator", current, transitioned(current))).not.toThrow();
    expect(() =>
      assertEditorDocumentFeatureDelta("free", transitioned(current), transitioned(current, "wipe-left")),
    ).toThrow(PlanRequirementError);
  });

  test("lets a downgraded workspace remove or disable active motion", () => {
    const none = baseDocument();
    expect(() => assertEditorDocumentFeatureDelta("free", transitioned(none), none)).not.toThrow();
    const motion = {
      schemaVersion: 1 as const,
      id: "50000000-0000-4000-8000-000000000001",
      target: { kind: "broll" as const },
      startSec: 0,
      endSec: 2,
      entrance: "pan-left" as const,
      exit: "ken-burns-out" as const,
      durationSec: 0.5,
      enabled: true,
    };
    const animated = { ...none, mediaMotions: [motion] };
    expect(() => assertEditorDocumentFeatureDelta("free", none, animated)).toThrow(PlanRequirementError);
    expect(() =>
      assertEditorDocumentFeatureDelta("free", animated, { ...animated, mediaMotions: [{ ...motion, enabled: false }] }),
    ).not.toThrow();
  });
});

describe("assertEditorDocumentFeatureDelta censor", () => {
  function documentWithCensor(): EditorDocument {
    return editorDocumentSchema.parse({
      ...baseDocument(),
      censorSegments: [{
        schemaVersion: 1,
        id: "50000000-0000-4000-8000-000000000001",
        sourceWordIds: ["word:one"],
        sourceStartSec: 1,
        sourceEndSec: 1.4,
        treatment: "beep",
        paddingSec: 0.06,
        beepSettings: { frequencyHz: 1_000, levelDb: -8 },
        captionMaskPolicy: null,
        suggestionFingerprint: "e".repeat(64),
        policyVersion: "auto-censor-v1",
        enabled: true,
      }],
    });
  }

  test("lets a downgraded workspace disable or remove an existing censor", () => {
    const current = documentWithCensor();
    expect(() => assertEditorDocumentFeatureDelta("free", current, {
      ...current,
      censorSegments: [{ ...current.censorSegments[0]!, enabled: false }],
    })).not.toThrow();
    expect(() => assertEditorDocumentFeatureDelta("free", current, { ...current, censorSegments: [] })).not.toThrow();
  });

  test("still gates creating, enabling, or editing an enabled censor", () => {
    const current = documentWithCensor();
    const disabled = { ...current, censorSegments: [{ ...current.censorSegments[0]!, enabled: false }] };
    const refusal = expect.objectContaining({ code: "plan_feature_required", details: expect.objectContaining({ feature: "editor.censoring" }) });
    expect(() => assertEditorDocumentFeatureDelta("free", disabled, current)).toThrow(refusal);
    expect(() => assertEditorDocumentFeatureDelta("free", baseDocument(), current)).toThrow(refusal);
    expect(() => assertEditorDocumentFeatureDelta("free", current, {
      ...current,
      censorSegments: [{ ...current.censorSegments[0]!, paddingSec: 0.1 }],
    })).toThrow(refusal);
  });
});
