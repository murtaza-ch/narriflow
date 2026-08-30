import { describe, expect, test } from "bun:test";

import { DEFAULT_CAPTION_PRESET } from "./caption-preset";
import {
  EDITOR_HISTORY_LIMIT,
  applyEditorAction,
  applyWithHistory,
  canRedo,
  canUndo,
  createEditorHistory,
  deletedRangesEqual,
  editorDocumentSchema,
  editorDocumentsEqual,
  redoEditor,
  undoEditor,
  type EditorDocument,
} from "./editor-document";
import {
  studioEditsSchema,
  studioSfxPlacementSchema,
  studioTextLayerSchema,
} from "./studio-edits";
import type { TranscriptUtterance } from "./transcript";

function makeUtterance(
  index: number,
  startSec: number,
  words: string[],
): TranscriptUtterance {
  const wordDur = 0.5;
  return {
    index,
    speaker: 0,
    speakerLabel: "Speaker A",
    startSec,
    endSec: startSec + words.length * wordDur,
    text: words.join(" "),
    confidence: null,
    words: words.map((word, i) => ({
      word,
      startSec: startSec + i * wordDur,
      endSec: startSec + (i + 1) * wordDur,
      confidence: null,
    })),
  };
}

function makeDocument(): EditorDocument {
  return editorDocumentSchema.parse({
    clipStartSec: 10,
    clipEndSec: 40,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [
      makeUtterance(0, 10, ["so", "as", "you", "can"]),
      makeUtterance(1, 14, ["this", "smaller", "again"]),
    ],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges: [],
  });
}

function makeDocumentWithTextLayer(
  startSec: number,
  endSec: number | null,
): EditorDocument {
  const doc = makeDocument();
  return {
    ...doc,
    studioEdits: {
      ...doc.studioEdits,
      textLayers: [
        studioTextLayerSchema.parse({ id: "layer-1", text: "Hello", startSec, endSec }),
      ],
    },
  };
}

function makeDocumentWithSfx(startSec: number): EditorDocument {
  const doc = makeDocument();
  return {
    ...doc,
    studioEdits: {
      ...doc.studioEdits,
      sfx: [
        studioSfxPlacementSchema.parse({
          id: "sfx-1",
          assetId: "11111111-1111-4111-8111-111111111111",
          startSec,
        }),
      ],
    },
  };
}

describe("Clip Editor Document equality", () => {
  test("accepts the same reference and separately allocated canonical documents", () => {
    const document = makeDocument();

    expect(editorDocumentsEqual(document, document)).toBe(true);
    expect(editorDocumentsEqual(document, structuredClone(document))).toBe(true);
  });

  test("ignores object property insertion order after schema parsing", () => {
    const document = makeDocument();
    const reversed = Object.fromEntries(
      Object.entries(structuredClone(document)).reverse(),
    );

    expect(
      editorDocumentsEqual(
        editorDocumentSchema.parse(document),
        editorDocumentSchema.parse(reversed),
      ),
    ).toBe(true);
  });

  test("detects a change in every top-level field", () => {
    const document = makeDocument();
    const changedDocuments: EditorDocument[] = [
      { ...document, clipStartSec: 11 },
      { ...document, clipEndSec: 41 },
      {
        ...document,
        captionPreset: {
          ...document.captionPreset,
          primaryColor: "#123456",
        },
      },
      {
        ...document,
        transcriptSlice: [
          {
            ...document.transcriptSlice[0]!,
            text: "changed transcript",
          },
          ...document.transcriptSlice.slice(1),
        ],
      },
      {
        ...document,
        studioEdits: {
          ...document.studioEdits,
          sourceAudio: {
            ...document.studioEdits.sourceAudio,
            muted: true,
          },
        },
      },
      { ...document, brollUrl: "https://example.com/broll.mp4" },
      {
        ...document,
        deletedRanges: [{ startSec: 12, endSec: 13 }],
      },
    ];

    for (const changed of changedDocuments) {
      expect(editorDocumentsEqual(document, changed)).toBe(false);
    }
  });

  test("keeps ordered transcript, layer, placement, and override arrays order-sensitive", () => {
    const document = makeDocument();
    const textLayers = [
      studioTextLayerSchema.parse({ id: "layer-1", text: "First" }),
      studioTextLayerSchema.parse({ id: "layer-2", text: "Second" }),
    ];
    const sfx = [
      studioSfxPlacementSchema.parse({
        id: "sfx-1",
        assetId: "11111111-1111-4111-8111-111111111111",
        startSec: 1,
      }),
      studioSfxPlacementSchema.parse({
        id: "sfx-2",
        assetId: "22222222-2222-4222-8222-222222222222",
        startSec: 2,
      }),
    ];
    const overrides = [
      {
        id: "override-1",
        aspectRatio: "9:16" as const,
        startSec: 0,
        endSec: 5,
        layout: "single" as const,
        layers: [
          {
            role: "single" as const,
            frameX: 0,
            frameY: 0,
            frameWidth: 1,
            frameHeight: 1,
            rotationDeg: 0,
            cropCxNorm: 0.5,
            cropCyNorm: 0.5,
            cropZoom: 1,
          },
        ],
      },
      {
        id: "override-2",
        aspectRatio: "9:16" as const,
        startSec: 5,
        endSec: 10,
        layout: "single" as const,
        layers: [
          {
            role: "single" as const,
            frameX: 0,
            frameY: 0,
            frameWidth: 1,
            frameHeight: 1,
            rotationDeg: 0,
            cropCxNorm: 0.6,
            cropCyNorm: 0.5,
            cropZoom: 1,
          },
        ],
      },
    ];
    const populated = editorDocumentSchema.parse({
      ...document,
      studioEdits: {
        ...document.studioEdits,
        textLayers,
        sfx,
        speakerLayoutOverrides: overrides,
      },
    });

    const reorderings = [
      {
        ...populated,
        transcriptSlice: [...populated.transcriptSlice].reverse(),
      },
      {
        ...populated,
        studioEdits: {
          ...populated.studioEdits,
          textLayers: [...populated.studioEdits.textLayers].reverse(),
        },
      },
      {
        ...populated,
        studioEdits: {
          ...populated.studioEdits,
          sfx: [...populated.studioEdits.sfx].reverse(),
        },
      },
      {
        ...populated,
        studioEdits: {
          ...populated.studioEdits,
          speakerLayoutOverrides: [
            ...populated.studioEdits.speakerLayoutOverrides,
          ].reverse(),
        },
      },
    ];

    for (const reordered of reorderings) {
      expect(editorDocumentsEqual(populated, reordered)).toBe(false);
    }
  });

  test("normalizes deleted ranges before comparing their domain meaning", () => {
    const window = { startSec: 10, endSec: 40 };

    expect(
      deletedRangesEqual(
        [
          { startSec: 14, endSec: 16 },
          { startSec: 12, endSec: 15 },
        ],
        [{ startSec: 12, endSec: 16 }],
        window,
      ),
    ).toBe(true);
  });

  test("returns after an early scalar difference without reading a large transcript", () => {
    const document = {
      ...makeDocument(),
      transcriptSlice: Array.from({ length: 500 }, (_, index) =>
        makeUtterance(index, 10 + index * 0.01, ["word"]),
      ),
    };
    const changed = {
      ...document,
      clipStartSec: document.clipStartSec + 1,
    };
    Object.defineProperty(changed, "transcriptSlice", {
      get() {
        throw new Error("transcript should not be read after a scalar mismatch");
      },
    });

    expect(
      editorDocumentsEqual(
        document,
        changed as unknown as EditorDocument,
      ),
    ).toBe(false);
  });
});

describe("applyEditorAction", () => {
  test("updateWordText changes one word and rebuilds utterance text only", () => {
    const doc = makeDocument();
    const next = applyEditorAction(doc, {
      type: "updateWordText",
      utteranceIndex: 1,
      wordIndex: 1,
      text: "bigger",
    });
    const utterance = next.transcriptSlice[1]!;
    expect(utterance.text).toBe("this bigger again");
    expect(utterance.words[1]!.word).toBe("bigger");
    // Timings are untouched — no proportional redistribution.
    expect(utterance.words.map((w) => w.startSec)).toEqual(
      doc.transcriptSlice[1]!.words.map((w) => w.startSec),
    );
    // Untouched utterance is referentially identical.
    expect(next.transcriptSlice[0]).toBe(doc.transcriptSlice[0]!);
  });

  test("updateWordText out of bounds is a no-op returning the same reference", () => {
    const doc = makeDocument();
    expect(
      applyEditorAction(doc, {
        type: "updateWordText",
        utteranceIndex: 9,
        wordIndex: 0,
        text: "x",
      }),
    ).toBe(doc);
  });

  test("deleteRange normalizes and merges into the deleted set", () => {
    const doc = makeDocument();
    const once = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 14, endSec: 15.5 },
    });
    const twice = applyEditorAction(once, {
      type: "deleteRange",
      range: { startSec: 15.5, endSec: 17 },
    });
    expect(twice.deletedRanges).toEqual([{ startSec: 14, endSec: 17 }]);
  });

  test("revertRange splits a deletion", () => {
    const doc = applyEditorAction(makeDocument(), {
      type: "deleteRange",
      range: { startSec: 14, endSec: 20 },
    });
    const next = applyEditorAction(doc, {
      type: "revertRange",
      range: { startSec: 16, endSec: 17 },
    });
    expect(next.deletedRanges).toEqual([
      { startSec: 14, endSec: 16 },
      { startSec: 17, endSec: 20 },
    ]);
  });

  test("setClipBoundaries rebases deletions into the new window", () => {
    const doc = applyEditorAction(makeDocument(), {
      type: "deleteRange",
      range: { startSec: 12, endSec: 35 },
    });
    const next = applyEditorAction(doc, {
      type: "setClipBoundaries",
      startSec: 15,
      endSec: 30,
    });
    expect(next.deletedRanges).toEqual([{ startSec: 15, endSec: 30 }]);
  });

  test("reset returns the original document", () => {
    const original = makeDocument();
    const mutated = applyEditorAction(original, {
      type: "setBrollUrl",
      brollUrl: "https://example.com/broll.mp4",
    });
    expect(applyEditorAction(mutated, { type: "reset", original })).toBe(original);
  });

  test("setBrollUrl with the same URL is a semantic no-op (same reference)", () => {
    const doc = applyEditorAction(makeDocument(), {
      type: "setBrollUrl",
      brollUrl: "https://example.com/a.mp4",
    });
    expect(
      applyEditorAction(doc, { type: "setBrollUrl", brollUrl: "https://example.com/a.mp4" }),
    ).toBe(doc);
  });

  test("setCaptionPreset with a deep-equal (but new) object is a no-op", () => {
    const doc = makeDocument();
    const next = applyEditorAction(doc, {
      type: "setCaptionPreset",
      // Structurally identical to doc.captionPreset but a fresh object.
      captionPreset: { ...doc.captionPreset },
    });
    expect(next).toBe(doc);
  });

  test("setStudioEdits with a deep-equal (but new) object is a no-op", () => {
    const doc = makeDocument();
    const next = applyEditorAction(doc, {
      type: "setStudioEdits",
      studioEdits: JSON.parse(JSON.stringify(doc.studioEdits)),
    });
    expect(next).toBe(doc);
  });

  test("setTranscriptSlice with a deep-equal (but new) array is a no-op", () => {
    const doc = makeDocument();
    const next = applyEditorAction(doc, {
      type: "setTranscriptSlice",
      transcriptSlice: JSON.parse(JSON.stringify(doc.transcriptSlice)),
    });
    expect(next).toBe(doc);
  });

  test("setClipBoundaries with unchanged bounds is a no-op", () => {
    const doc = makeDocument();
    const next = applyEditorAction(doc, {
      type: "setClipBoundaries",
      startSec: doc.clipStartSec,
      endSec: doc.clipEndSec,
    });
    expect(next).toBe(doc);
  });

  test("setDeletedRanges with an equivalent (differently-ordered) set is a no-op", () => {
    const doc = applyEditorAction(makeDocument(), {
      type: "setDeletedRanges",
      ranges: [{ startSec: 14, endSec: 15 }],
    });
    const next = applyEditorAction(doc, {
      type: "setDeletedRanges",
      ranges: [{ startSec: 14, endSec: 15 }],
    });
    expect(next).toBe(doc);
  });
});

// Fix 2 (Phase B hardening): text layers store EDITED-timeline
// startSec/endSec at creation; deleting/reverting EARLIER footage must
// rebase them at the reducer level (not a component effect) so undo/redo
// each land on an internally-consistent document.
describe("text-layer ripple", () => {
  test("deleteRange shifts a layer after the cut left by exactly the cut duration", () => {
    // window [10,40) uncut -> edited 0 === source 10. Layer at edited
    // [20,25) sits at source [30,35). Deleting source [12,17) (5s, entirely
    // before the layer) shifts everything after it left by 5s.
    const doc = makeDocumentWithTextLayer(20, 25);
    const next = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    const layer = next.studioEdits.textLayers[0]!;
    expect(layer.startSec).toBe(15);
    expect(layer.endSec).toBe(20);
  });

  test("revertRange shifts the layer back to its exact original position", () => {
    const doc = makeDocumentWithTextLayer(20, 25);
    const deleted = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    const reverted = applyEditorAction(deleted, {
      type: "revertRange",
      range: { startSec: 12, endSec: 17 },
    });
    const layer = reverted.studioEdits.textLayers[0]!;
    expect(layer.startSec).toBe(20);
    expect(layer.endSec).toBe(25);
  });

  test("a layer whose whole window falls inside a new cut clamps to a 0.5s floor at the collapse point", () => {
    // Layer at edited [5,8) === source [15,18) -- entirely inside the
    // about-to-be-deleted source range [14,20).
    const doc = makeDocumentWithTextLayer(5, 8);
    const next = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 14, endSec: 20 },
    });
    const layer = next.studioEdits.textLayers[0]!;
    // Both endpoints collapse forward onto the cut point (edited 4 — where
    // the surviving source[20,40) segment now starts) -- clamped to a 0.5s
    // minimum duration there rather than disappearing or going inverted.
    expect(layer.startSec).toBe(4);
    expect(layer.endSec).toBe(4.5);
    expect(layer.endSec! - layer.startSec).toBeCloseTo(0.5, 5);
  });

  test("a layer with no endSec (plays to clip end) only rebases its start", () => {
    const doc = makeDocumentWithTextLayer(20, null);
    const next = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    const layer = next.studioEdits.textLayers[0]!;
    expect(layer.startSec).toBe(15);
    expect(layer.endSec).toBeNull();
  });

  test("setClipBoundaries rebases layers against the new window, not just deletedRanges", () => {
    // Layer at edited [5,8) === source [15,18). Trimming the clip's start
    // forward to 12 shifts edited-time zero itself, moving the layer left
    // by the same 2s even with no deletedRanges involved.
    const doc = makeDocumentWithTextLayer(5, 8);
    const next = applyEditorAction(doc, {
      type: "setClipBoundaries",
      startSec: 12,
      endSec: 40,
    });
    const layer = next.studioEdits.textLayers[0]!;
    expect(layer.startSec).toBe(3);
    expect(layer.endSec).toBe(6);
  });

  test("undo restores the layer's pre-delete position exactly", () => {
    let history = createEditorHistory(makeDocumentWithTextLayer(20, 25));
    history = applyWithHistory(history, {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    expect(history.present.studioEdits.textLayers[0]!.startSec).toBe(15);

    history = undoEditor(history);
    const layer = history.present.studioEdits.textLayers[0]!;
    expect(layer.startSec).toBe(20);
    expect(layer.endSec).toBe(25);
  });

  test("a delete that doesn't actually change deletedRanges (fully-covered no-op) leaves textLayers referentially identical", () => {
    const doc = applyEditorAction(makeDocumentWithTextLayer(20, 25), {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    const next = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    expect(next).toBe(doc);
    expect(next.studioEdits.textLayers).toBe(doc.studioEdits.textLayers);
  });

  describe("trimClip (vizard-parity.md Phase B step 13)", () => {
    test("shrinking the window applies bounds + slice atomically and rebases deletions", () => {
      const doc = applyEditorAction(makeDocument(), {
        type: "deleteRange",
        range: { startSec: 12, endSec: 35 },
      });
      const newSlice = [makeUtterance(0, 15, ["this", "smaller"])];
      const next = applyEditorAction(doc, {
        type: "trimClip",
        startSec: 15,
        endSec: 30,
        transcriptSlice: newSlice,
      });
      expect(next.clipStartSec).toBe(15);
      expect(next.clipEndSec).toBe(30);
      expect(next.transcriptSlice).toBe(newSlice);
      // Same rebase `setClipBoundaries` already covers a unit test for above.
      expect(next.deletedRanges).toEqual([{ startSec: 15, endSec: 30 }]);
    });

    test("extending the window into new words applies bounds + slice atomically", () => {
      const doc = makeDocument();
      const extendedSlice = [
        makeUtterance(0, 5, ["earlier", "words"]),
        ...doc.transcriptSlice,
      ];
      const next = applyEditorAction(doc, {
        type: "trimClip",
        startSec: 5,
        endSec: doc.clipEndSec,
        transcriptSlice: extendedSlice,
      });
      expect(next.clipStartSec).toBe(5);
      expect(next.transcriptSlice).toBe(extendedSlice);
    });

    test("rebases text layers against the new window exactly like setClipBoundaries", () => {
      const doc = makeDocumentWithTextLayer(5, 8);
      const next = applyEditorAction(doc, {
        type: "trimClip",
        startSec: 12,
        endSec: 40,
        transcriptSlice: doc.transcriptSlice,
      });
      const layer = next.studioEdits.textLayers[0]!;
      expect(layer.startSec).toBe(3);
      expect(layer.endSec).toBe(6);
    });

    test("unchanged bounds AND unchanged slice is a no-op returning the same reference", () => {
      const doc = makeDocument();
      const next = applyEditorAction(doc, {
        type: "trimClip",
        startSec: doc.clipStartSec,
        endSec: doc.clipEndSec,
        transcriptSlice: JSON.parse(JSON.stringify(doc.transcriptSlice)),
      });
      expect(next).toBe(doc);
    });

    test("undo restores slice + bounds + ranges + layers exactly", () => {
      let history = createEditorHistory(makeDocumentWithTextLayer(20, 25));
      const before = history.present;
      history = applyWithHistory(history, {
        type: "trimClip",
        startSec: 15,
        endSec: 30,
        transcriptSlice: [makeUtterance(0, 15, ["this", "smaller"])],
      });
      expect(history.present).not.toBe(before);

      history = undoEditor(history);
      expect(history.present).toBe(before);
      expect(history.present.clipStartSec).toBe(before.clipStartSec);
      expect(history.present.clipEndSec).toBe(before.clipEndSec);
      expect(history.present.transcriptSlice).toBe(before.transcriptSlice);
      expect(history.present.deletedRanges).toBe(before.deletedRanges);
      expect(history.present.studioEdits.textLayers).toBe(before.studioEdits.textLayers);
    });
  });
});

// H2 fix (vizard-parity.md "Music/SFX library"): `studioEdits.sfx[].startSec`
// is edited-timeline seconds exactly like a text layer's `startSec` — it
// needs the same ripple rebase on delete/revert/boundary-change, but
// `rebaseStudioEdits` used to only touch `textLayers`, leaving every SFX
// placement pointing at the wrong instant. Mirrors "text-layer ripple"
// above; the one behavioral difference is that a placement whose source
// instant collapses into a new cut is DROPPED (a single instant has no
// window to clamp into), not clamped to a floor duration.
describe("sfx ripple", () => {
  test("deleteRange shifts a placement after the cut left by exactly the cut duration", () => {
    // window [10,40) uncut -> edited 0 === source 10. Placement at edited 20
    // sits at source 30. Deleting source [12,17) (5s, entirely before the
    // placement) shifts everything after it left by 5s.
    const doc = makeDocumentWithSfx(20);
    const next = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    expect(next.studioEdits.sfx).toHaveLength(1);
    expect(next.studioEdits.sfx[0]!.startSec).toBe(15);
  });

  test("revertRange shifts the placement back to its exact original position", () => {
    const doc = makeDocumentWithSfx(20);
    const deleted = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    const reverted = applyEditorAction(deleted, {
      type: "revertRange",
      range: { startSec: 12, endSec: 17 },
    });
    expect(reverted.studioEdits.sfx[0]!.startSec).toBe(20);
  });

  test("a placement whose source instant falls inside a new cut is dropped, not clamped", () => {
    // Placement at edited 5 === source 15 -- entirely inside the
    // about-to-be-deleted source range [14,20).
    const doc = makeDocumentWithSfx(5);
    const next = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 14, endSec: 20 },
    });
    expect(next.studioEdits.sfx).toEqual([]);
  });

  test("a placement after the cut is unaffected in position when the cut is entirely after it", () => {
    // Placement at edited 2 === source 12. Deleting source [20,25) (well
    // after the placement) must not move it at all.
    const doc = makeDocumentWithSfx(2);
    const next = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 20, endSec: 25 },
    });
    expect(next.studioEdits.sfx[0]!.startSec).toBe(2);
  });

  test("setClipBoundaries rebases placements against the new window, not just deletedRanges", () => {
    // Placement at edited 5 === source 15. Trimming the clip's start forward
    // to 12 shifts edited-time zero itself, moving the placement left by the
    // same 2s even with no deletedRanges involved.
    const doc = makeDocumentWithSfx(5);
    const next = applyEditorAction(doc, {
      type: "setClipBoundaries",
      startSec: 12,
      endSec: 40,
    });
    expect(next.studioEdits.sfx[0]!.startSec).toBe(3);
  });

  test("undo restores the placement's pre-delete position exactly", () => {
    let history = createEditorHistory(makeDocumentWithSfx(20));
    history = applyWithHistory(history, {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    expect(history.present.studioEdits.sfx[0]!.startSec).toBe(15);

    history = undoEditor(history);
    expect(history.present.studioEdits.sfx[0]!.startSec).toBe(20);
  });

  test("a delete that doesn't actually change deletedRanges (fully-covered no-op) leaves sfx referentially identical", () => {
    const doc = applyEditorAction(makeDocumentWithSfx(20), {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    const next = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 12, endSec: 17 },
    });
    expect(next).toBe(doc);
    expect(next.studioEdits.sfx).toBe(doc.studioEdits.sfx);
  });

  describe("trimClip", () => {
    test("rebases sfx placements against the new window exactly like setClipBoundaries", () => {
      const doc = makeDocumentWithSfx(5);
      const next = applyEditorAction(doc, {
        type: "trimClip",
        startSec: 12,
        endSec: 40,
        transcriptSlice: doc.transcriptSlice,
      });
      expect(next.studioEdits.sfx[0]!.startSec).toBe(3);
    });

    test("undo restores sfx placements exactly", () => {
      let history = createEditorHistory(makeDocumentWithSfx(20));
      const before = history.present;
      history = applyWithHistory(history, {
        type: "trimClip",
        startSec: 15,
        endSec: 30,
        transcriptSlice: [makeUtterance(0, 15, ["this", "smaller"])],
      });
      expect(history.present).not.toBe(before);

      history = undoEditor(history);
      expect(history.present).toBe(before);
      expect(history.present.studioEdits.sfx).toBe(before.studioEdits.sfx);
    });
  });
});

describe("history", () => {
  test("undo/redo walk the document states", () => {
    let history = createEditorHistory(makeDocument());
    history = applyWithHistory(history, {
      type: "setBrollUrl",
      brollUrl: "https://example.com/a.mp4",
    });
    history = applyWithHistory(history, {
      type: "deleteRange",
      range: { startSec: 14, endSec: 15 },
    });

    expect(canUndo(history)).toBe(true);
    expect(canRedo(history)).toBe(false);

    history = undoEditor(history);
    expect(history.present.deletedRanges).toEqual([]);
    expect(history.present.brollUrl).toBe("https://example.com/a.mp4");
    expect(canRedo(history)).toBe(true);

    history = undoEditor(history);
    expect(history.present.brollUrl).toBeNull();
    expect(canUndo(history)).toBe(false);

    history = redoEditor(history);
    history = redoEditor(history);
    expect(history.present.deletedRanges).toEqual([{ startSec: 14, endSec: 15 }]);
    expect(redoEditor(history)).toBe(history);
  });

  test("a new edit clears the redo branch", () => {
    let history = createEditorHistory(makeDocument());
    history = applyWithHistory(history, {
      type: "setBrollUrl",
      brollUrl: "https://example.com/a.mp4",
    });
    history = undoEditor(history);
    history = applyWithHistory(history, {
      type: "setBrollUrl",
      brollUrl: "https://example.com/b.mp4",
    });
    expect(canRedo(history)).toBe(false);
    expect(history.present.brollUrl).toBe("https://example.com/b.mp4");
  });

  test("same coalesceKey collapses a gesture into one undo step", () => {
    let history = createEditorHistory(makeDocument());
    for (let size = 37; size <= 44; size += 1) {
      history = applyWithHistory(
        history,
        {
          type: "setCaptionPreset",
          captionPreset: { ...history.present.captionPreset, fontSize: size },
        },
        { coalesceKey: "caption.fontSize" },
      );
    }
    expect(history.present.captionPreset.fontSize).toBe(44);
    expect(history.past).toHaveLength(1);

    history = undoEditor(history);
    expect(history.present.captionPreset.fontSize).toBe(36);
  });

  test("a different key after a gesture starts a new step", () => {
    let history = createEditorHistory(makeDocument());
    history = applyWithHistory(
      history,
      {
        type: "setCaptionPreset",
        captionPreset: { ...history.present.captionPreset, fontSize: 44 },
      },
      { coalesceKey: "caption.fontSize" },
    );
    history = applyWithHistory(history, {
      type: "setBrollUrl",
      brollUrl: "https://example.com/a.mp4",
    });
    expect(history.past).toHaveLength(2);
  });

  test("history is capped", () => {
    let history = createEditorHistory(makeDocument());
    for (let i = 0; i < EDITOR_HISTORY_LIMIT + 20; i += 1) {
      history = applyWithHistory(history, {
        type: "setBrollUrl",
        brollUrl: `https://example.com/${i}.mp4`,
      });
    }
    expect(history.past).toHaveLength(EDITOR_HISTORY_LIMIT);
  });

  test("no-op actions do not grow history", () => {
    let history = createEditorHistory(makeDocument());
    history = applyWithHistory(history, {
      type: "updateWordText",
      utteranceIndex: 9,
      wordIndex: 0,
      text: "x",
    });
    expect(history.past).toHaveLength(0);
  });

  // Fix 9 (unified-editor-history.ts's meta-undo stack): callers detect "did
  // this apply push a new past frame" via `past` reference INEQUALITY rather
  // than length growth, because length stops growing once the cap is hit.
  // These two tests pin down the two halves of that contract so a future
  // change to applyWithHistory can't silently break it.
  test("every non-coalesced apply produces a new `past` array reference, even at the cap", () => {
    let history = createEditorHistory(makeDocument());
    for (let i = 0; i < EDITOR_HISTORY_LIMIT + 5; i += 1) {
      const prevPast = history.past;
      history = applyWithHistory(history, {
        type: "setBrollUrl",
        brollUrl: `https://example.com/${i}.mp4`,
      });
      expect(history.past).not.toBe(prevPast);
    }
    expect(history.past).toHaveLength(EDITOR_HISTORY_LIMIT);
  });

  test("a coalesced apply at the cap keeps the exact same `past` reference", () => {
    let history = createEditorHistory(makeDocument());
    for (let i = 0; i < EDITOR_HISTORY_LIMIT + 5; i += 1) {
      history = applyWithHistory(history, {
        type: "setBrollUrl",
        brollUrl: `https://example.com/${i}.mp4`,
      });
    }
    // First apply of a NEW coalesceKey still pushes a frame (its predecessor
    // had no/a different key) — past length stays capped, but the reference
    // changes (asserted by the previous test). Only the SECOND apply with
    // the SAME key actually coalesces, which is what this test pins down.
    history = applyWithHistory(
      history,
      { type: "setCaptionPreset", captionPreset: { ...history.present.captionPreset, fontSize: 50 } },
      { coalesceKey: "caption.fontSize" },
    );
    const pastAfterFirstGestureTick = history.past;
    history = applyWithHistory(
      history,
      { type: "setCaptionPreset", captionPreset: { ...history.present.captionPreset, fontSize: 51 } },
      { coalesceKey: "caption.fontSize" },
    );
    expect(history.past).toBe(pastAfterFirstGestureTick);
    expect(history.past).toHaveLength(EDITOR_HISTORY_LIMIT);
  });
});
