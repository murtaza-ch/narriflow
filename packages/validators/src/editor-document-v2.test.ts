import { describe, expect, test } from "bun:test";

import {
  EDITOR_DOCUMENT_VERSION,
  applyEditorAction,
  applyWithHistory,
  createEditorHistory,
  editorDocumentSchema,
  redoEditor,
  undoEditor,
} from "./editor-document";
import { DEFAULT_CAPTION_PRESET } from "./caption-preset";
import { studioEditsSchema } from "./studio-edits";

function currentDocument() {
  return {
		version: EDITOR_DOCUMENT_VERSION,
    clipStartSec: 10,
    clipEndSec: 30,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
		brollPlacements: [],
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

describe("Clip Editor Document v2", () => {
	test("persists bounded asset-backed B-roll without changing clip duration", () => {
		const base = editorDocumentSchema.parse(currentDocument());
		const placement = {
			id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
			asset: {
				kind: "visual_asset" as const,
				id: "8ab9d330-688f-4574-932c-27ac661245c1",
				fingerprint: "a".repeat(64),
			},
			provenance: "generated" as const,
			mediaKind: "image" as const,
			startSec: 3,
			endSec: 6,
			sourceStartSec: null,
			sourceEndSec: null,
		};

		const history = applyWithHistory(createEditorHistory(base), {
			type: "insertBrollPlacement",
			placement,
		});

		expect(history.past).toHaveLength(1);
		expect(history.present.brollPlacements).toEqual([placement]);
		expect(history.present.clipEndSec - history.present.clipStartSec).toBe(20);
		expect(undoEditor(history).present.brollPlacements).toEqual([]);
	});

	test("replaces and deletes one selected B-roll placement as atomic history actions", () => {
		const placementId = "2adf79cc-35b2-4de5-85dc-c9ed197763e4";
		const initial = editorDocumentSchema.parse({
			...currentDocument(),
			brollPlacements: [{
				id: placementId,
				asset: {
					kind: "visual_asset",
					id: "8ab9d330-688f-4574-932c-27ac661245c1",
					fingerprint: "a".repeat(64),
				},
				provenance: "uploaded",
				mediaKind: "image",
				startSec: 3,
				endSec: 6,
				sourceStartSec: null,
				sourceEndSec: null,
			}],
		});
		const replacement = {
			kind: "visual_asset" as const,
			id: "d8ab95f8-fc16-4e60-814e-69762a59a99b",
			fingerprint: "b".repeat(64),
		};
		let history = applyWithHistory(createEditorHistory(initial), {
			type: "replaceBrollPlacement",
			id: placementId,
			asset: replacement,
			provenance: "generated",
			mediaKind: "video",
			sourceStartSec: 1,
			sourceEndSec: 4,
		});
		expect(history.present.brollPlacements).toEqual([{
			...initial.brollPlacements[0],
			asset: replacement,
			provenance: "generated",
			mediaKind: "video",
			sourceStartSec: 1,
			sourceEndSec: 4,
		}]);
		expect(history.past).toHaveLength(1);

		history = applyWithHistory(history, {
			type: "deleteBrollPlacement",
			id: placementId,
		});
		expect(history.present.brollPlacements).toEqual([]);
		expect(history.past).toHaveLength(2);
		expect(undoEditor(history).present.brollPlacements[0]?.asset).toEqual(replacement);
	});

	test("rejects overlapping, out-of-range, or incoherent B-roll placements", () => {
		const image = {
			id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
			asset: {
				kind: "visual_asset" as const,
				id: "8ab9d330-688f-4574-932c-27ac661245c1",
				fingerprint: "a".repeat(64),
			},
			provenance: "generated" as const,
			mediaKind: "image" as const,
			startSec: 3,
			endSec: 6,
			sourceStartSec: null,
			sourceEndSec: null,
		};
		expect(editorDocumentSchema.safeParse({
			...currentDocument(),
			brollPlacements: [image, { ...image, id: crypto.randomUUID(), startSec: 5 }],
		}).success).toBe(false);
		expect(editorDocumentSchema.safeParse({
			...currentDocument(),
			brollPlacements: [{ ...image, endSec: 21 }],
		}).success).toBe(false);
		expect(editorDocumentSchema.safeParse({
			...currentDocument(),
			brollPlacements: [{ ...image, sourceStartSec: 0, sourceEndSec: 3 }],
		}).success).toBe(false);
		expect(editorDocumentSchema.safeParse({
			...currentDocument(),
			brollPlacements: [{
				...image,
				mediaKind: "video",
				sourceStartSec: 0,
				sourceEndSec: 2,
			}],
		}).success).toBe(false);
	});

	test("Scene Blocks extend the timeline while still B-roll remains bounded overlay", () => {
		const base = editorDocumentSchema.parse({
			...currentDocument(),
			brollPlacements: [{
				id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
				asset: {
					kind: "visual_asset",
					id: "8ab9d330-688f-4574-932c-27ac661245c1",
					fingerprint: "a".repeat(64),
				},
				provenance: "generated",
				mediaKind: "image",
				startSec: 3,
				endSec: 6,
				sourceStartSec: null,
				sourceEndSec: null,
			}],
		});
		const withScene = applyEditorAction(base, {
			type: "insertSceneBlock",
			scene: colorScene("d8ab95f8-fc16-4e60-814e-69762a59a99b", 6, 3),
		});

		expect(base.clipEndSec - base.clipStartSec).toBe(20);
		expect(base.brollPlacements[0]).toMatchObject({ startSec: 3, endSec: 6 });
		expect(
			withScene.clipEndSec - withScene.clipStartSec +
				withScene.sceneBlocks.reduce((sum, scene) => sum + scene.durationSec, 0),
		).toBe(23);
	});

	test("rebases asset-backed B-roll with source footage after ripple deletion", () => {
		const base = editorDocumentSchema.parse({
			...currentDocument(),
			brollPlacements: [{
				id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
				asset: {
					kind: "visual_asset",
					id: "8ab9d330-688f-4574-932c-27ac661245c1",
					fingerprint: "a".repeat(64),
				},
				provenance: "generated",
				mediaKind: "image",
				startSec: 8,
				endSec: 12,
				sourceStartSec: null,
				sourceEndSec: null,
			}],
		});

		const deleted = applyEditorAction(base, {
			type: "deleteRange",
			range: { startSec: 12, endSec: 14 },
		});

		expect(deleted.brollPlacements[0]).toMatchObject({ startSec: 6, endSec: 10 });
		expect(editorDocumentSchema.safeParse(deleted).success).toBe(true);
	});

  test("accepts the approved Scene media-motion vocabulary and rejects removed aliases", () => {
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
    for (const [index, entrance] of entrances.entries()) {
      const exit = exits[index]!;
      expect(editorDocumentSchema.parse({
        ...currentDocument(),
        sceneBlocks: [{
          ...colorScene(crypto.randomUUID(), 0),
          motion: { entrance, exit },
        }],
      }).sceneBlocks[0]?.motion).toEqual({ entrance, exit });
    }
    expect(() => editorDocumentSchema.parse({
      ...currentDocument(),
      sceneBlocks: [{
        ...colorScene(crypto.randomUUID(), 0),
        motion: { entrance: "zoom-in", exit: "slide-down" },
      }],
    })).toThrow();
  });

  test("blocks unbounded or overlapping animated-media schedules before save", () => {
    const mediaMotion = (index: number, entrance: "fade" | "none" = "fade") => ({
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      target: { kind: "broll" as const },
      startSec: index * 0.5,
      endSec: index * 0.5 + 0.5,
      entrance,
      exit: "none" as const,
      enabled: true,
    });
    expect(editorDocumentSchema.safeParse({
      ...currentDocument(),
      mediaMotions: Array.from({ length: 32 }, (_, index) => mediaMotion(index)),
    }).success).toBe(true);
    expect(editorDocumentSchema.safeParse({
      ...currentDocument(),
      mediaMotions: Array.from({ length: 33 }, (_, index) => mediaMotion(index)),
    }).error?.issues).toContainEqual(expect.objectContaining({
      message: "animated media cannot exceed 32 placements",
    }));
    expect(editorDocumentSchema.safeParse({
      ...currentDocument(),
      mediaMotions: [
        mediaMotion(0),
        { ...mediaMotion(1), startSec: 0.25, endSec: 0.75 },
      ],
    }).error?.issues).toContainEqual(expect.objectContaining({
      message: "enabled media motions cannot overlap on one target",
    }));
    expect(editorDocumentSchema.safeParse({
      ...currentDocument(),
      mediaMotions: Array.from({ length: 33 }, (_, index) =>
        mediaMotion(index, "none")),
    }).success).toBe(true);
  });
  test("accepts only the current strict document version", () => {
		const current = currentDocument();
		expect(editorDocumentSchema.parse(current)).toEqual(current);
		expect(() => editorDocumentSchema.parse(({ ...current, version: 1 }))).toThrow();
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

  test("keeps explicit Scene media motion attached through Scene timeline edits", () => {
    const first = colorScene("8ab9d330-688f-4574-932c-27ac661245c1", 2, 2);
    const second = colorScene("d8ab95f8-fc16-4e60-814e-69762a59a99b", 6, 2);
    const base = editorDocumentSchema.parse({
      ...currentDocument(),
      sceneBlocks: [first, second],
      mediaMotions: [{
        schemaVersion: 1,
        id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
        target: { kind: "scene_block", sceneBlockId: second.id },
        startSec: 6,
        endSec: 8,
        entrance: "fade",
        exit: "scale-out",
        enabled: true,
      }],
    });

    const moved = applyEditorAction(base, {
      type: "moveSceneBlock",
      id: second.id,
      anchorSec: 7,
    });
    expect(moved.mediaMotions[0]).toMatchObject({ startSec: 7, endSec: 9 });

    const trimmed = applyEditorAction(moved, {
      type: "trimSceneBlock",
      id: second.id,
      durationSec: 3,
    });
    expect(trimmed.mediaMotions[0]).toMatchObject({ startSec: 7, endSec: 10 });

    const intro = colorScene("a3196d76-b71d-4b93-8812-7435b9e17faf", 0, 1);
    const inserted = applyEditorAction(trimmed, {
      type: "insertSceneBlock",
      scene: intro,
    });
    expect(inserted.mediaMotions[0]).toMatchObject({ startSec: 8, endSec: 11 });

    const deleted = applyEditorAction(inserted, {
      type: "deleteSceneBlock",
      id: first.id,
    });
    expect(deleted.mediaMotions[0]).toMatchObject({ startSec: 6, endSec: 9 });
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
    })).toThrow();
  });

  test("applies reviewed Censor Segments as one undoable document edit", () => {
    const base = editorDocumentSchema.parse(currentDocument());
    const makeSegment = (id: string, treatment: "beep" | "caption_mask") => ({
      schemaVersion: 1 as const,
      id,
      sourceWordIds: [`word:${id}`],
      sourceStartSec: 12,
      sourceEndSec: 12.4,
      treatment,
      paddingSec: 0.08,
      beepSettings: treatment === "beep" ? { frequencyHz: 1_000, levelDb: -12 } : null,
      captionMaskPolicy: treatment === "caption_mask"
        ? { replacement: "asterisks" as const, preservePunctuation: true }
        : null,
      suggestionFingerprint: id.replaceAll("-", "").slice(0, 32),
      policyVersion: "auto-censor:v1",
      enabled: true,
    });
    const first = makeSegment("dbb670b3-e28a-4514-bf2d-63e56608a4d0", "beep");
    const second = makeSegment("2adf79cc-35b2-4de5-85dc-c9ed197763e4", "caption_mask");

    const applied = applyWithHistory(createEditorHistory(base), {
      type: "applyCensorSegments",
      segments: [first, second],
    });

    expect(applied.past).toHaveLength(1);
    expect(applied.present.censorSegments).toEqual([first, second]);
    expect(undoEditor(applied).present.censorSegments).toEqual([]);
    expect(redoEditor(undoEditor(applied)).present.censorSegments).toEqual([
      first,
      second,
    ]);
    expect(applyEditorAction(applied.present, {
      type: "applyCensorSegments",
      segments: [first],
    })).toBe(applied.present);
  });
});
