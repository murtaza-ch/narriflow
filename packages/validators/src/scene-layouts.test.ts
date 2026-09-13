import { describe, expect, test } from "bun:test";
import { captionPresetSchema } from "./caption-preset";
import { applyEditorAction, editorDocumentSchema } from "./editor-document";
import {
  removeSceneLayoutSelection,
  replaceSceneLayoutSelection,
  sceneLayoutSelectionAt,
  studioSceneLayoutSelectionsSchema,
  type StudioSceneLayoutSelection,
} from "./scene-layouts";
import { studioEditsSchema } from "./studio-edits";

const selection = (
  id: string,
  aspectRatio: StudioSceneLayoutSelection["aspectRatio"],
  startSec: number,
  endSec: number,
  preset: StudioSceneLayoutSelection["preset"] = "full",
): StudioSceneLayoutSelection => ({ id, aspectRatio, startSec, endSec, preset });

describe("scene layout selections", () => {
  test("uses end-exclusive lookup boundaries", () => {
    const selections = [selection("first", "9:16", 1, 2)];
    expect(sceneLayoutSelectionAt(selections, "9:16", 1)?.id).toBe("first");
    expect(sceneLayoutSelectionAt(selections, "9:16", 1.999)?.id).toBe("first");
    expect(sceneLayoutSelectionAt(selections, "9:16", 2)).toBeNull();
    expect(sceneLayoutSelectionAt(selections, "1:1", 1.5)).toBeNull();
  });

  test("rejects overlap within an aspect and permits the same window across aspects", () => {
    expect(
      studioSceneLayoutSelectionsSchema.safeParse([
        selection("a", "9:16", 0, 4),
        selection("b", "9:16", 3, 5),
      ]).success,
    ).toBe(false);
    expect(
      studioSceneLayoutSelectionsSchema.safeParse([
        selection("a", "9:16", 0, 4),
        selection("b", "16:9", 0, 4),
      ]).success,
    ).toBe(true);
    expect(
      studioSceneLayoutSelectionsSchema.safeParse([
        selection("too-short", "9:16", 1, 1.074),
      ]).success,
    ).toBe(false);
  });

  test("replaces only the requested interval and preserves both remainders", () => {
    const result = replaceSceneLayoutSelection(
      [selection("old", "9:16", 0, 10), selection("wide", "16:9", 0, 10)],
      selection("new", "9:16", 3, 7, "inset"),
    );
    expect(result.map(({ aspectRatio, startSec, endSec, preset }) => ({
      aspectRatio,
      startSec,
      endSec,
      preset,
    }))).toEqual([
      { aspectRatio: "16:9", startSec: 0, endSec: 10, preset: "full" },
      { aspectRatio: "9:16", startSec: 0, endSec: 3, preset: "full" },
      { aspectRatio: "9:16", startSec: 3, endSec: 7, preset: "inset" },
      { aspectRatio: "9:16", startSec: 7, endSec: 10, preset: "full" },
    ]);
  });

  test("apply-all is one interval for one aspect and reset reveals the default", () => {
    const current = [
      selection("portrait-a", "9:16", 0, 2),
      selection("portrait-b", "9:16", 2, 10),
      selection("wide", "16:9", 0, 10),
    ];
    const applied = replaceSceneLayoutSelection(
      current,
      selection("all", "9:16", 0, 10, "stacked"),
    );
    expect(applied).toEqual([
      selection("wide", "16:9", 0, 10),
      selection("all", "9:16", 0, 10, "stacked"),
    ]);
    expect(
      removeSceneLayoutSelection(applied, {
        aspectRatio: "9:16",
        startSec: 0,
        endSec: 10,
      }),
    ).toEqual([selection("wide", "16:9", 0, 10)]);
  });

  test("rebases intervals when source footage is deleted", () => {
    const document = editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 10,
      clipEndSec: 20,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({
        sceneLayouts: [selection("scene", "9:16", 2, 8)],
      }),
      brollUrl: null,
      deletedRanges: [],
    });
    const next = applyEditorAction(document, {
      type: "deleteRange",
      range: { startSec: 11, endSec: 13 },
    });
    expect(next.studioEdits.sceneLayouts).toEqual([
      selection("scene", "9:16", 1, 6),
    ]);
  });

  test("editor documents reject intervals beyond the edited source duration", () => {
    const parsed = editorDocumentSchema.safeParse({
      version: 2,
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({
        sceneLayouts: [selection("outside", "9:16", 4, 6)],
      }),
      brollUrl: null,
      deletedRanges: [],
    });
    expect(parsed.success).toBe(false);
  });
});
