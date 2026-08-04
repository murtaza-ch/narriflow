import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  EDITOR_HISTORY_LIMIT,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import type { EditorDocument } from "@narriflow/validators";
import {
  applyUnifiedEditorAction,
  canRedoUnified,
  canUndoUnified,
  createUnifiedEditorHistory,
  type UnifiedEditorHistory,
} from "./unified-editor-history";
import type { TimelineSegment } from "./studio-shell";

function makeDocument(): EditorDocument {
  return editorDocumentSchema.parse({
    clipStartSec: 0,
    clipEndSec: 30,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges: [],
  });
}

const segmentsA: TimelineSegment[] = [
  { id: "seg-0", label: "Clip", startSec: 0, endSec: 30 },
];
const segmentsB: TimelineSegment[] = [
  { id: "seg-0", label: "Clip", startSec: 0, endSec: 15 },
  { id: "seg-0-b", label: "Clip", startSec: 15, endSec: 30 },
];
const segmentsC: TimelineSegment[] = [
  { id: "seg-0", label: "Clip", startSec: 0, endSec: 10 },
  { id: "seg-0-b", label: "Clip", startSec: 10, endSec: 30 },
];

function initial(): UnifiedEditorHistory {
  return createUnifiedEditorHistory(makeDocument(), segmentsA);
}

describe("applyUnifiedEditorAction", () => {
  test("interleaves document and segment mutations in one undo order", () => {
    let state = initial();
    state = applyUnifiedEditorAction(state, {
      kind: "document",
      action: { type: "setBrollUrl", brollUrl: "https://example.com/a.mp4" },
    });
    state = applyUnifiedEditorAction(state, { kind: "segments", segments: segmentsB });
    state = applyUnifiedEditorAction(state, {
      kind: "document",
      action: { type: "setBrollUrl", brollUrl: "https://example.com/b.mp4" },
    });

    expect(canUndoUnified(state)).toBe(true);
    expect(canRedoUnified(state)).toBe(false);

    // Undo 1: pops the LAST mutation regardless of kind (document, here).
    state = applyUnifiedEditorAction(state, { kind: "undo" });
    expect(state.doc.present.brollUrl).toBe("https://example.com/a.mp4");
    expect(state.segments).toBe(segmentsB);

    // Undo 2: pops the segment split.
    state = applyUnifiedEditorAction(state, { kind: "undo" });
    expect(state.segments).toEqual(segmentsA);
    expect(state.doc.present.brollUrl).toBe("https://example.com/a.mp4");

    // Undo 3: pops the first document mutation.
    state = applyUnifiedEditorAction(state, { kind: "undo" });
    expect(state.doc.present.brollUrl).toBeNull();
    expect(canUndoUnified(state)).toBe(false);

    // Redo replays the exact same order forward.
    state = applyUnifiedEditorAction(state, { kind: "redo" });
    expect(state.doc.present.brollUrl).toBe("https://example.com/a.mp4");
    state = applyUnifiedEditorAction(state, { kind: "redo" });
    expect(state.segments).toEqual(segmentsB);
    state = applyUnifiedEditorAction(state, { kind: "redo" });
    expect(state.doc.present.brollUrl).toBe("https://example.com/b.mp4");
    expect(canRedoUnified(state)).toBe(false);
  });

  test("a coalesced gesture collapses into one meta undo step", () => {
    let state = initial();
    for (let size = 37; size <= 44; size += 1) {
      state = applyUnifiedEditorAction(state, {
        kind: "document",
        action: {
          type: "setCaptionPreset",
          captionPreset: { ...state.doc.present.captionPreset, fontSize: size },
        },
        coalesceKey: "caption.fontSize",
      });
    }
    expect(state.metaUndo).toEqual(["document"]);
    expect(state.doc.present.captionPreset.fontSize).toBe(44);

    state = applyUnifiedEditorAction(state, { kind: "undo" });
    expect(state.doc.present.captionPreset.fontSize).toBe(36);
    expect(canUndoUnified(state)).toBe(false);
  });

  test("a new mutation after undo clears the whole redo side", () => {
    let state = initial();
    state = applyUnifiedEditorAction(state, {
      kind: "document",
      action: { type: "setBrollUrl", brollUrl: "https://example.com/a.mp4" },
    });
    state = applyUnifiedEditorAction(state, { kind: "segments", segments: segmentsB });
    state = applyUnifiedEditorAction(state, { kind: "undo" }); // undo segments
    expect(canRedoUnified(state)).toBe(true);

    state = applyUnifiedEditorAction(state, { kind: "segments", segments: segmentsC });
    expect(canRedoUnified(state)).toBe(false);
    expect(state.segments).toEqual(segmentsC);
  });

  test("a no-op document action does not push a meta undo entry", () => {
    let state = initial();
    state = applyUnifiedEditorAction(state, {
      kind: "document",
      action: {
        type: "updateWordText",
        utteranceIndex: 9,
        wordIndex: 0,
        text: "x",
      },
    });
    expect(state.metaUndo).toEqual([]);
    expect(canUndoUnified(state)).toBe(false);
  });

  test("undo/redo are no-ops on an empty stack", () => {
    const state = initial();
    expect(applyUnifiedEditorAction(state, { kind: "undo" })).toBe(state);
    expect(applyUnifiedEditorAction(state, { kind: "redo" })).toBe(state);
  });

  // Fix 8a: a segments action must break the document's coalesce chain so a
  // gesture that was mid-coalesce before a segment split (or one that starts
  // right after it, reusing the same key) never silently merges across it.
  test("a segments action breaks the document coalesce chain (Codex repro: 36->37 [key], split, 37->38 [same key])", () => {
    let state = initial();
    expect(state.doc.present.captionPreset.fontSize).toBe(36);

    state = applyUnifiedEditorAction(state, {
      kind: "document",
      action: {
        type: "setCaptionPreset",
        captionPreset: { ...state.doc.present.captionPreset, fontSize: 37 },
      },
      coalesceKey: "caption.fontSize",
    });
    state = applyUnifiedEditorAction(state, { kind: "segments", segments: segmentsB });
    state = applyUnifiedEditorAction(state, {
      kind: "document",
      action: {
        type: "setCaptionPreset",
        captionPreset: { ...state.doc.present.captionPreset, fontSize: 38 },
      },
      coalesceKey: "caption.fontSize",
    });

    // Two distinct document undo steps (36->37, then 37->38), not one — the
    // segment split in between must have broken the coalesce chain despite
    // both document edits sharing the same coalesceKey.
    expect(state.doc.past).toHaveLength(2);
    expect(state.doc.present.captionPreset.fontSize).toBe(38);
    expect(state.metaUndo).toEqual(["document", "segments", "document"]);

    state = applyUnifiedEditorAction(state, { kind: "undo" });
    expect(state.doc.present.captionPreset.fontSize).toBe(37);
    state = applyUnifiedEditorAction(state, { kind: "undo" });
    expect(state.segments).toEqual(segmentsA);
    state = applyUnifiedEditorAction(state, { kind: "undo" });
    expect(state.doc.present.captionPreset.fontSize).toBe(36);
    expect(canUndoUnified(state)).toBe(false);
  });

  // Fix 8b: gesture end (slider pointer-up, drag end) dispatches endCoalesce
  // so the NEXT gesture — even one reusing the same coalesceKey — starts a
  // fresh undo step instead of merging into the one that already finished.
  test("endCoalesce breaks the chain without recording its own undo step", () => {
    let state = initial();
    state = applyUnifiedEditorAction(state, {
      kind: "document",
      action: {
        type: "setCaptionPreset",
        captionPreset: { ...state.doc.present.captionPreset, fontSize: 40 },
      },
      coalesceKey: "caption.fontSize",
    });
    const metaUndoBefore = state.metaUndo;
    const pastBefore = state.doc.past;

    state = applyUnifiedEditorAction(state, { kind: "endCoalesce" });
    expect(state.metaUndo).toBe(metaUndoBefore); // no new meta entry
    expect(state.doc.past).toBe(pastBefore); // no new doc frame
    expect(state.doc.lastCoalesceKey).toBeNull();

    // endCoalesce on an already-clear key is a true no-op (same reference).
    expect(applyUnifiedEditorAction(state, { kind: "endCoalesce" })).toBe(state);

    state = applyUnifiedEditorAction(state, {
      kind: "document",
      action: {
        type: "setCaptionPreset",
        captionPreset: { ...state.doc.present.captionPreset, fontSize: 41 },
      },
      coalesceKey: "caption.fontSize",
    });
    // Did NOT coalesce with the pre-endCoalesce step, despite the same key.
    expect(state.doc.past).toHaveLength(2);
    expect(state.metaUndo).toEqual(["document", "document"]);
  });

  // Fix 9: meta-undo tagging must keep working past EDITOR_HISTORY_LIMIT,
  // where the document history's `past` length stops growing but a fresh
  // reference is still allocated per pushed frame (see editor-document.ts).
  test("meta undo tagging survives the document history cap", () => {
    let state = initial();
    const totalEdits = EDITOR_HISTORY_LIMIT + 10;
    for (let i = 0; i < totalEdits; i += 1) {
      state = applyUnifiedEditorAction(state, {
        kind: "document",
        action: { type: "setBrollUrl", brollUrl: `https://example.com/${i}.mp4` },
      });
    }
    expect(state.doc.past).toHaveLength(EDITOR_HISTORY_LIMIT);
    expect(state.metaUndo).toHaveLength(totalEdits);
    expect(state.metaUndo.every((kind) => kind === "document")).toBe(true);
  });
});
