import { describe, expect, test } from "bun:test";

import {
  EDITOR_DOCUMENT_VERSION,
  applyEditorAction,
  applyWithHistory,
  createEditorHistory,
  editorActionSchema,
  editorDocumentSchema,
  redoEditor,
  undoEditor,
} from "./editor-document";
import { DEFAULT_CAPTION_PRESET } from "./caption-preset";
import { AUTO_CENSOR_POLICY_VERSION } from "./auto-censor";
import { studioEditsSchema } from "./studio-edits";
import { mediaMotionSchema, sceneMotionSchema } from "./timed-edits";

function currentDocument() {
  return {
		version: EDITOR_DOCUMENT_VERSION,
    clipStartSec: 10,
    clipEndSec: 30,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges: [],
		sceneBlocks: [],
		censorSegments: [],
		mediaMotions: [],
  };
}

const colorScene = (id: string, anchorSec: number, durationSec = 2) => ({
  id,
  schemaVersion: 1 as const,
  anchorSec,
  durationSec,
  content: { kind: "color" as const, color: "#111827" },
  motion: { entrance: "none" as const, exit: "none" as const },
  templateSnapshot: null,
});

describe("Clip Editor Document", () => {
  test("uses one bounded media-motion vocabulary for scenes and placements", () => {
    const entrances = [
      "none",
      "fade",
      "scale-in",
      "pan-left",
      "pan-right",
      "pan-up",
      "pan-down",
      "ken-burns-in",
    ] as const;
    const exits = [
      "none",
      "fade",
      "scale-out",
      "pan-left",
      "pan-right",
      "pan-up",
      "pan-down",
      "ken-burns-out",
    ] as const;

    for (const entrance of entrances) {
      expect(sceneMotionSchema.parse({ entrance, exit: "none" })).toEqual({
        entrance,
        exit: "none",
        durationSec: 0.5,
      });
    }
    for (const exit of exits) {
      expect(sceneMotionSchema.parse({ entrance: "none", exit })).toEqual({
        entrance: "none",
        exit,
        durationSec: 0.5,
      });
    }

    expect(
      mediaMotionSchema.parse({
        schemaVersion: 1,
        id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
        target: { kind: "broll" },
        startSec: 0,
        endSec: 1,
        entrance: "fade",
        exit: "ken-burns-out",
        enabled: true,
      }),
    ).toMatchObject({ durationSec: 0.5 });
  });

  test("accepts only the current strict document version", () => {
		const current = currentDocument();
		expect(editorDocumentSchema.parse(current)).toEqual(current);
		expect(() => editorDocumentSchema.parse(({ ...current, version: 99 }))).toThrow();
		expect(() => editorDocumentSchema.parse(({ ...current, version: undefined }))).toThrow();
  });

  test("rejects unknown future versions and unknown document fields", () => {
    expect(() => editorDocumentSchema.parse({ ...currentDocument(), version: 99 })).toThrow();
    expect(() => editorDocumentSchema.parse({ ...currentDocument(), surprise: true })).toThrow();
  });

  test("enforces bounded unique timed edits and valid asset references", () => {
    const base = editorDocumentSchema.parse(currentDocument());
    const duplicate = colorScene("8ab9d330-688f-4574-932c-27ac661245c1", 1);
    expect(() => editorDocumentSchema.parse({ ...base, sceneBlocks: [duplicate, duplicate] })).toThrow();
    expect(() => editorDocumentSchema.parse({
      ...base,
      sceneBlocks: Array.from({ length: 65 }, (_, index) =>
        colorScene(crypto.randomUUID(), index * 0.1, 0.1)),
    })).toThrow();
    expect(() => editorDocumentSchema.parse({
      ...base,
      sceneBlocks: [{
        ...duplicate,
        content: {
          kind: "image",
          asset: { kind: "visual_asset", id: crypto.randomUUID(), fingerprint: "" },
          fit: "cover",
          backgroundColor: "#000000",
        },
      }],
    })).toThrow();
    const invalidMotion = {
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      target: { kind: "broll" as const },
      startSec: 0,
      endSec: 999,
      entrance: "ken-burns-in" as const,
      exit: "pan-down" as const,
      enabled: true,
    };
    expect(applyEditorAction(base, { type: "insertMediaMotion", motion: invalidMotion })).toBe(base);

    expect(() => editorDocumentSchema.parse({
      ...base,
      sceneBlocks: [20, 50, 80, 110].map((anchorSec) =>
        colorScene(crypto.randomUUID(), anchorSec, 30)),
    })).toThrow("total edited duration cannot exceed 120 seconds");
  });

  test("bounds animated targets and simultaneous media-motion work", () => {
    const scenes = Array.from({ length: 5 }, (_, index) =>
      colorScene(crypto.randomUUID(), index * 2, 2),
    );
    const motions = scenes.map((scene) => ({
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      target: { kind: "scene_block" as const, sceneBlockId: scene.id },
      startSec: 0,
      endSec: 5,
      entrance: "fade" as const,
      exit: "fade" as const,
      durationSec: 0.5,
      enabled: true,
    }));
    expect(() =>
      editorDocumentSchema.parse({ ...currentDocument(), sceneBlocks: scenes, mediaMotions: motions }),
    ).toThrow("no more than 4 media motions may overlap");
    expect(() =>
      editorDocumentSchema.parse({
        ...currentDocument(),
        sceneBlocks: [scenes[0]],
        mediaMotions: [motions[0], { ...motions[0], id: crypto.randomUUID() }],
      }),
    ).toThrow("a media target can have only one motion");
  });

  test("insert, move, trim, duplicate, replace, and delete remap anchors deterministically", () => {
    const base = editorDocumentSchema.parse(currentDocument());
    const first = colorScene("8ab9d330-688f-4574-932c-27ac661245c1", 3, 2);
    const second = colorScene("d8ab95f8-fc16-4e60-814e-69762a59a99b", 8, 3);

    const inserted = applyEditorAction(base, { type: "insertSceneBlock", scene: first });
    const insertedAgain = applyEditorAction(inserted, { type: "insertSceneBlock", scene: second });
    expect(insertedAgain.sceneBlocks.map((scene) => [scene.id, scene.anchorSec])).toEqual([
      [first.id, 3],
      [second.id, 8],
    ]);

    const moved = applyEditorAction(insertedAgain, {
      type: "moveSceneBlock",
      id: first.id,
      anchorSec: 10,
    });
    expect(moved.sceneBlocks.map((scene) => [scene.id, scene.anchorSec])).toEqual([
      [second.id, 6],
      [first.id, 10],
    ]);

    const trimmed = applyEditorAction(moved, {
      type: "trimSceneBlock",
      id: second.id,
      durationSec: 1,
    });
    expect(trimmed.sceneBlocks.find((scene) => scene.id === first.id)?.anchorSec).toBe(8);

    const duplicateId = "a3196d76-b71d-4b93-8812-7435b9e17faf";
    const duplicated = applyEditorAction(trimmed, {
      type: "duplicateSceneBlock",
      id: second.id,
      duplicateId,
    });
    expect(duplicated.sceneBlocks.find((scene) => scene.id === duplicateId)?.anchorSec).toBe(7);

    const replaced = applyEditorAction(duplicated, {
      type: "replaceSceneBlock",
      id: duplicateId,
      content: { kind: "text", text: "Next chapter", fontFamily: "Arial", fontAsset: null, color: "#FFFFFF", backgroundColor: "#111827" },
    });
    expect(replaced.sceneBlocks.find((scene) => scene.id === duplicateId)?.content.kind).toBe("text");
		const replacedWithShortVideo = applyEditorAction(replaced, {
			type: "replaceSceneBlock",
			id: first.id,
			content: {
				kind: "video",
				asset: { kind: "visual_asset", id: crypto.randomUUID(), fingerprint: "a".repeat(64) },
				sourceStartSec: 0,
				sourceEndSec: 0.5,
				fit: "cover",
				backgroundColor: "#000000",
				muted: false,
				volume: 100,
			},
		});
		expect(replacedWithShortVideo.sceneBlocks.find((scene) => scene.id === first.id)?.durationSec).toBe(0.5);

		const deleted = applyEditorAction(replacedWithShortVideo, { type: "deleteSceneBlock", id: second.id });
    expect(deleted.sceneBlocks.some((scene) => scene.id === second.id)).toBe(false);
    expect(deleted.sceneBlocks.find((scene) => scene.id === duplicateId)?.anchorSec).toBe(6);
  });

  test("censor and media-motion edits are strict, toggleable, undoable, redoable, and no-op stable", () => {
    const scene = colorScene("8ab9d330-688f-4574-932c-27ac661245c1", 20, 2);
    const base = editorDocumentSchema.parse({
      ...editorDocumentSchema.parse(currentDocument()),
      sceneBlocks: [scene],
    });
    const censor = {
      schemaVersion: 1 as const,
      id: "dbb670b3-e28a-4514-bf2d-63e56608a4d0",
      sourceWordIds: ["word-1"],
      sourceStartSec: 29.5,
      sourceEndSec: 30,
      treatment: "beep" as const,
      paddingSec: 0.1,
      beepSettings: { frequencyHz: 1_000, levelDb: -12 },
      captionMaskPolicy: null,
      suggestionFingerprint: "a".repeat(64),
      policyVersion: "profanity-v1",
      enabled: true,
    };
    const motion = {
      schemaVersion: 1 as const,
      id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
      target: { kind: "scene_block" as const, sceneBlockId: scene.id },
      startSec: 20,
      endSec: 22,
      entrance: "scale-in" as const,
      exit: "fade" as const,
      enabled: true,
    };
    let history = createEditorHistory(base);
    history = applyWithHistory(history, { type: "insertCensorSegment", segment: censor });
    history = applyWithHistory(history, { type: "setCensorSegmentEnabled", id: censor.id, enabled: false }, { coalesceKey: `censor:${censor.id}` });
    history = applyWithHistory(history, { type: "insertMediaMotion", motion });
    history = applyWithHistory(history, { type: "setMediaMotionEnabled", id: motion.id, enabled: false });
    expect(history.present.censorSegments[0]?.enabled).toBe(false);
    expect(history.present.mediaMotions[0]?.enabled).toBe(false);

    const noOp = applyWithHistory(history, { type: "setMediaMotionEnabled", id: motion.id, enabled: false });
    expect(noOp).toBe(history);
    const undone = undoEditor(history);
    expect(undone.present.mediaMotions[0]?.enabled).toBe(true);
    expect(redoEditor(undone).present.mediaMotions[0]?.enabled).toBe(false);

    const deletedScene = applyEditorAction(history.present, { type: "deleteSceneBlock", id: scene.id });
    expect(deletedScene.mediaMotions).toEqual([]);
    expect(() => editorDocumentSchema.parse({
      ...deletedScene,
      censorSegments: [{ ...censor, sourceStartSec: 15, sourceEndSec: 16 }],
      deletedRanges: [{ startSec: 14, endSec: 17 }],
    })).not.toThrow();
  });

  test("keeps deleted censors valid, removes outside segments, and clamps trim overlaps", () => {
    const makeCensor = (id: string, sourceStartSec: number) => ({
      schemaVersion: 1 as const,
      id,
      sourceWordIds: [`word:${id}`],
      sourceStartSec,
      sourceEndSec: sourceStartSec + 0.4,
      treatment: "mute" as const,
      paddingSec: 0.06,
      beepSettings: null,
      captionMaskPolicy: null,
      suggestionFingerprint: "d".repeat(64),
      policyVersion: AUTO_CENSOR_POLICY_VERSION,
      enabled: true,
    });
    const removedByCut = makeCensor("40000000-0000-4000-8000-000000000001", 12);
    const keptByTrim = makeCensor("40000000-0000-4000-8000-000000000002", 24);
    const clampedByTrim = {
      ...makeCensor("40000000-0000-4000-8000-000000000003", 19.8),
      sourceEndSec: 20.2,
    };
    const base = editorDocumentSchema.parse({
      ...currentDocument(),
      censorSegments: [removedByCut, keptByTrim, clampedByTrim],
    });
    const cut = applyEditorAction(base, {
      type: "setDeletedRanges",
      ranges: [{ startSec: 11.5, endSec: 12.5 }],
    });
    expect(() => editorDocumentSchema.parse(cut)).not.toThrow();
    expect(cut.censorSegments).toHaveLength(3);

    const trimmed = applyEditorAction(cut, {
      type: "trimClip",
      startSec: 20,
      endSec: 30,
      transcriptSlice: [],
    });
    expect(() => editorDocumentSchema.parse(trimmed)).not.toThrow();
    expect(trimmed.censorSegments.map((segment) => segment.id)).toEqual([
      keptByTrim.id,
      clampedByTrim.id,
    ]);
    expect(trimmed.censorSegments[1]).toMatchObject({
      sourceStartSec: 20,
      sourceEndSec: 20.2,
    });
  });

  test("applies a reviewed censor batch as one undo entry", () => {
    const base = editorDocumentSchema.parse(currentDocument());
    const makeCensor = (id: string, startSec: number) => ({
      schemaVersion: 1 as const,
      id,
      sourceWordIds: [`word:${id}`],
      sourceStartSec: startSec,
      sourceEndSec: startSec + 0.4,
      treatment: "mute" as const,
      paddingSec: 0.05,
      beepSettings: null,
      captionMaskPolicy: null,
      suggestionFingerprint: "c".repeat(64),
      policyVersion: "auto-censor-v1",
      enabled: true,
    });
    const reviewed = [
      makeCensor("30000000-0000-4000-8000-000000000001", 12),
      makeCensor("30000000-0000-4000-8000-000000000002", 14),
    ];

    const applied = applyWithHistory(createEditorHistory(base), {
      type: "setCensorSegments",
      segments: reviewed,
    });

    expect(applied.present.censorSegments).toEqual(reviewed);
    expect(applied.past).toHaveLength(1);
    expect(undoEditor(applied).present.censorSegments).toEqual([]);
    expect(redoEditor(undoEditor(applied)).present.censorSegments).toEqual(reviewed);
  });

  test("caption emphasis overrides are strict, undoable, redoable, capped and no-op stable", () => {
    expect(editorActionSchema.safeParse({ type: "setCaptionEmphasis", keys: ["1200"], value: "hero" }).success).toBe(true);
    expect(editorActionSchema.safeParse({ type: "setCaptionEmphasis", keys: ["1200"], value: null }).success).toBe(true);
    expect(editorActionSchema.safeParse({ type: "setCaptionEmphasis", keys: [], value: "hero" }).success).toBe(false);
    expect(editorActionSchema.safeParse({ type: "setCaptionEmphasis", keys: ["1.2"], value: "hero" }).success).toBe(false);
    expect(editorActionSchema.safeParse({ type: "setCaptionEmphasis", keys: ["1200"], value: "big" }).success).toBe(false);
    expect(editorActionSchema.safeParse({ type: "setCaptionEmphasis", keys: ["1200"], value: "hero", extra: 1 }).success).toBe(false);

    const base = editorDocumentSchema.parse(currentDocument());
    let history = createEditorHistory(base);
    history = applyWithHistory(history, { type: "setCaptionEmphasis", keys: ["1200", "1500", "1800"], value: "plain" });
    expect(history.present.studioEdits.captionEmphasis).toEqual({ "1200": "plain", "1500": "plain", "1800": "plain" });
    // One gesture (clear the cue, then pick its hero) is one undo step.
    history = applyWithHistory(history, { type: "setCaptionEmphasis", keys: ["1200", "1500", "1800"], value: null }, { coalesceKey: "emphasis:1" });
    history = applyWithHistory(history, { type: "setCaptionEmphasis", keys: ["1500"], value: "pair" }, { coalesceKey: "emphasis:1" });
    expect(history.present.studioEdits.captionEmphasis).toEqual({ "1500": "pair" });
    expect(history.past).toHaveLength(2);
    expect(editorDocumentSchema.parse(history.present)).toEqual(history.present);

    expect(applyWithHistory(history, { type: "setCaptionEmphasis", keys: ["1500"], value: "pair" })).toBe(history);
    expect(applyWithHistory(history, { type: "setCaptionEmphasis", keys: ["9999"], value: null })).toBe(history);

    const undone = undoEditor(history);
    expect(undone.present.studioEdits.captionEmphasis).toEqual({ "1200": "plain", "1500": "plain", "1800": "plain" });
    expect(redoEditor(undone).present.studioEdits.captionEmphasis).toEqual({ "1500": "pair" });

    // Clearing the last override drops the field.
    const cleared = applyEditorAction(history.present, { type: "setCaptionEmphasis", keys: ["1500"], value: null });
    expect("captionEmphasis" in cleared.studioEdits).toBe(false);

    const keys = Array.from({ length: 2000 }, (_, index) => String(index));
    const full = applyEditorAction(base, { type: "setCaptionEmphasis", keys, value: "plain" });
    expect(Object.keys(full.studioEdits.captionEmphasis ?? {})).toHaveLength(2000);
    expect(applyEditorAction(full, { type: "setCaptionEmphasis", keys: ["5000"], value: "hero" })).toBe(full);
    expect(applyEditorAction(full, { type: "setCaptionEmphasis", keys: ["0"], value: "hero" }).studioEdits.captionEmphasis?.["0"]).toBe("hero");
  });

  test("caption emojis are strict, one undo step per action, capped and no-op stable", () => {
    expect(editorActionSchema.safeParse({ type: "setCaptionEmojis", entries: { "1200": { id: "fire" } } }).success).toBe(true);
    expect(editorActionSchema.safeParse({ type: "setCaptionEmojis", entries: { "1200": null } }).success).toBe(true);
    expect(editorActionSchema.safeParse({ type: "setCaptionEmojis", entries: {} }).success).toBe(false);
    expect(editorActionSchema.safeParse({ type: "setCaptionEmojis", entries: { "1.2": { id: "fire" } } }).success).toBe(false);
    expect(editorActionSchema.safeParse({ type: "setCaptionEmojis", entries: { "1200": { id: "Fire" } } }).success).toBe(false);
    expect(editorActionSchema.safeParse({ type: "setCaptionEmojis", entries: { "1200": { id: "fire" } }, extra: 1 }).success).toBe(false);
    expect(editorActionSchema.safeParse({ type: "replaceCaptionEmojis", value: {} }).success).toBe(true);
    expect(editorActionSchema.safeParse({ type: "replaceCaptionEmojis", value: { "1200": null } }).success).toBe(false);

    const base = editorDocumentSchema.parse(currentDocument());
    let history = createEditorHistory(base);
    history = applyWithHistory(history, { type: "setCaptionEmojis", entries: { "1200": { id: "fire" }, "1500": { id: "thumbs-up", tone: 3 } } });
    expect(history.present.studioEdits.captionEmojis).toEqual({ "1200": { id: "fire" }, "1500": { id: "thumbs-up", tone: 3 } });
    history = applyWithHistory(history, { type: "setCaptionEmojis", entries: { "1200": null, "1800": { id: "rocket" } } });
    expect(history.present.studioEdits.captionEmojis).toEqual({ "1500": { id: "thumbs-up", tone: 3 }, "1800": { id: "rocket" } });
    expect(history.past).toHaveLength(2);
    expect(editorDocumentSchema.parse(history.present)).toEqual(history.present);

    // Same refs, or removing an absent key, change nothing.
    expect(applyWithHistory(history, { type: "setCaptionEmojis", entries: { "1800": { id: "rocket" } } })).toBe(history);
    expect(applyWithHistory(history, { type: "setCaptionEmojis", entries: { "9999": null } })).toBe(history);
    expect(applyWithHistory(history, { type: "setCaptionEmojis", entries: { "1500": { id: "thumbs-up" } } })).not.toBe(history);

    // Regenerate replaces every emoji in one step; Remove all drops the field.
    const regenerated = applyWithHistory(history, { type: "replaceCaptionEmojis", value: { "2100": { id: "brain" } } });
    expect(regenerated.present.studioEdits.captionEmojis).toEqual({ "2100": { id: "brain" } });
    expect(regenerated.past).toHaveLength(3);
    const removed = applyWithHistory(regenerated, { type: "replaceCaptionEmojis", value: {} });
    expect("captionEmojis" in removed.present.studioEdits).toBe(false);
    expect(undoEditor(removed).present.studioEdits.captionEmojis).toEqual({ "2100": { id: "brain" } });
    expect(undoEditor(undoEditor(removed)).present.studioEdits.captionEmojis).toEqual(history.present.studioEdits.captionEmojis);
    expect(redoEditor(undoEditor(removed)).present.studioEdits.captionEmojis).toBeUndefined();
    expect(applyWithHistory(removed, { type: "replaceCaptionEmojis", value: {} })).toBe(removed);

    const value = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [String(index), { id: "fire" }]));
    const full = applyEditorAction(base, { type: "replaceCaptionEmojis", value });
    expect(Object.keys(full.studioEdits.captionEmojis ?? {})).toHaveLength(500);
    expect(applyEditorAction(full, { type: "setCaptionEmojis", entries: { "5000": { id: "fire" } } })).toBe(full);
    expect(applyEditorAction(full, { type: "setCaptionEmojis", entries: { "0": { id: "rocket" } } }).studioEdits.captionEmojis?.["0"]).toEqual({ id: "rocket" });

    // Reset to original restores the original's emojis.
    expect(applyEditorAction(regenerated.present, { type: "reset", original: base }).studioEdits.captionEmojis).toBeUndefined();
  });
});
