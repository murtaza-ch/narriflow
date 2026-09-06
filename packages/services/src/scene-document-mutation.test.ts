import { afterEach, describe, expect, test } from "bun:test";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
  type SceneBlock,
} from "@narriflow/validators";
import { ClipActionError } from "./clip.service";
import { ProgramWriteDisabledError } from "./program-rollout";
import { analyzeSceneDocumentMutation } from "./scene-document-mutation";

const SCENE_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_SCENE_ID = "10000000-0000-4000-8000-000000000002";
const VISUAL_ASSET_ID = "20000000-0000-4000-8000-000000000001";
const SECOND_VISUAL_ASSET_ID = "20000000-0000-4000-8000-000000000002";
const BROLL_ID = "30000000-0000-4000-8000-000000000001";
const FONT_ID = "40000000-0000-4000-8000-000000000001";

const rolloutVariables = [
  "NARRIFLOW_WRITES_SCENE_CARDS",
  "NARRIFLOW_WRITES_SCENE_IMAGES",
  "NARRIFLOW_WRITES_SCENE_VIDEOS",
  "NARRIFLOW_WRITES_SCENE_TEMPLATES",
] as const;
const originalRollout = Object.fromEntries(
  rolloutVariables.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of rolloutVariables) {
    const value = originalRollout[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function enableSceneWrites() {
  for (const name of rolloutVariables) process.env[name] = "1";
}

function baseDocument(): EditorDocument {
  return editorDocumentSchema.parse({
    version: 2,
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

describe("analyzeSceneDocumentMutation", () => {
  test("returns no Scene Block work for an unchanged document", () => {
    const current = baseDocument();

    expect(analyzeSceneDocumentMutation(current, current, "free")).toEqual({
      changedSceneBlocks: [],
      introducedSceneReferences: [],
      introducedVisualAssetIds: [],
    });
  });

  test("rejects a Scene Block change when the workspace lacks the entitlement", () => {
    const current = baseDocument();
    const next = { ...current, sceneBlocks: [colorScene()] };

    expect(() => analyzeSceneDocumentMutation(current, next, "free")).toThrow(
      ClipActionError,
    );
    try {
      analyzeSceneDocumentMutation(current, next, "free");
    } catch (error) {
      expect(error).toMatchObject({ code: "scene_feature_unavailable" });
    }
  });

  test.each([
    ["scene_cards", colorScene()],
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
  ] as const)("rejects a changed %s Scene Block while its rollout is disabled", (group, scene) => {
    enableSceneWrites();
    process.env[`NARRIFLOW_WRITES_${group.toUpperCase()}`] = "0";
    const current = baseDocument();

    try {
      analyzeSceneDocumentMutation(
        current,
        { ...current, sceneBlocks: [scene] },
        "creator",
      );
      throw new Error("Expected Scene Block mutation to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ProgramWriteDisabledError);
      expect(error).toMatchObject({ group });
    }
  });

  test("classifies changed Scene Blocks separately from introduced references", () => {
    enableSceneWrites();
    const currentScene = imageScene();
    const current = { ...baseDocument(), sceneBlocks: [currentScene] };
    const restyled = {
      ...currentScene,
      content: { ...currentScene.content, fit: "contain" as const },
    };
    const introduced = imageScene(SECOND_SCENE_ID, SECOND_VISUAL_ASSET_ID);
    const next = { ...current, sceneBlocks: [restyled, introduced] };

    const analysis = analyzeSceneDocumentMutation(current, next, "creator");

    expect(analysis.changedSceneBlocks).toEqual([restyled, introduced]);
    expect(analysis.introducedSceneReferences).toEqual([introduced]);
  });

  test("includes removed Scene Blocks in policy without returning them for reference checks", () => {
    enableSceneWrites();
    const removed = colorScene();
    const current = { ...baseDocument(), sceneBlocks: [removed] };
    process.env.NARRIFLOW_WRITES_SCENE_CARDS = "0";

    expect(() =>
      analyzeSceneDocumentMutation(current, baseDocument(), "creator"),
    ).toThrow(ProgramWriteDisabledError);
  });

  test("deduplicates newly introduced visual assets across scenes and B-roll", () => {
    enableSceneWrites();
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
      analyzeSceneDocumentMutation(current, next, "creator")
        .introducedVisualAssetIds,
    ).toEqual([VISUAL_ASSET_ID, SECOND_VISUAL_ASSET_ID]);
  });

  test("treats a changed brand-font reference as newly introduced", () => {
    enableSceneWrites();
    const currentScene = colorScene(SCENE_ID, {
      content: {
        kind: "text",
        text: "Opening",
        fontFamily: "Archivo",
        fontAsset: null,
        color: "#FFFFFF",
        backgroundColor: "#000000",
      },
    });
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
        "creator",
      ).introducedSceneReferences,
    ).toEqual([nextScene]);
  });
});
