import { z } from "zod";

import { captionPresetSchema } from "./caption-preset";
import {
  buildEditedTimeMap,
  deletedRangesSchema,
  editedToSource,
  normalizeDeletedRanges,
  sourceRangeSchema,
  sourceToEdited,
  subtractDeletedRange,
  type ClipWindow,
  type EditedTimeMap,
  type SourceRange,
} from "./edit-ranges";
import { studioEditsSchema, type StudioTextLayer } from "./studio-edits";
import { transcriptUtteranceSchema } from "./transcript";

// The single editor document (vizard-parity.md Phase A step 2): everything the
// studio can mutate lives in one value so undo/redo, reset, and the atomic
// save contract all operate on one shape instead of four independently-PATCHed
// fragments. Clip boundaries are part of the document so in-studio trim
// (Phase B step 13) becomes just another undoable mutation.

export const editorDocumentSchema = z
  .object({
    clipStartSec: z.number().nonnegative(),
    clipEndSec: z.number().nonnegative(),
    captionPreset: captionPresetSchema,
    transcriptSlice: z.array(transcriptUtteranceSchema),
    studioEdits: studioEditsSchema,
    brollUrl: z.string().url().nullable().default(null),
    deletedRanges: deletedRangesSchema,
  })
  .refine((doc) => doc.clipEndSec > doc.clipStartSec, {
    message: "clipEndSec must be greater than clipStartSec",
  });

export type EditorDocument = z.infer<typeof editorDocumentSchema>;

/**
 * Optimistic-concurrency save envelope: the client sends the revision it
 * loaded (`baseRevision`) with the full document; the server accepts only if
 * the stored revision still matches, then increments. Replaces the previous
 * unversioned three-PATCH autosave (studio-shell.tsx:529).
 */
export const saveEditorDocumentSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  document: editorDocumentSchema,
});

export type SaveEditorDocument = z.infer<typeof saveEditorDocumentSchema>;

/** Body for POST .../editor/reset (Reset-to-original, Phase A step 4). */
export const resetEditorDocumentSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
});

export type ResetEditorDocument = z.infer<typeof resetEditorDocumentSchema>;

export const editorActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setCaptionPreset"), captionPreset: captionPresetSchema }),
  z.object({
    type: z.literal("setTranscriptSlice"),
    transcriptSlice: z.array(transcriptUtteranceSchema),
  }),
  z.object({
    type: z.literal("updateWordText"),
    utteranceIndex: z.number().int().nonnegative(),
    wordIndex: z.number().int().nonnegative(),
    text: z.string().trim().min(1),
  }),
  z.object({ type: z.literal("setStudioEdits"), studioEdits: studioEditsSchema }),
  z.object({ type: z.literal("setBrollUrl"), brollUrl: z.string().url().nullable() }),
  z.object({ type: z.literal("deleteRange"), range: sourceRangeSchema }),
  z.object({ type: z.literal("revertRange"), range: sourceRangeSchema }),
  z.object({ type: z.literal("setDeletedRanges"), ranges: deletedRangesSchema }),
  z.object({ type: z.literal("setClipBoundaries"), startSec: z.number().nonnegative(), endSec: z.number().nonnegative() }),
  z.object({
    type: z.literal("trimClip"),
    startSec: z.number().nonnegative(),
    endSec: z.number().nonnegative(),
    transcriptSlice: z.array(transcriptUtteranceSchema),
  }),
  z.object({ type: z.literal("reset"), original: editorDocumentSchema }),
]);

export type EditorAction = z.infer<typeof editorActionSchema>;

function documentWindow(doc: EditorDocument) {
  return { startSec: doc.clipStartSec, endSec: doc.clipEndSec };
}

/** Cheap-at-these-sizes deep-equality check used by the setter branches below
 *  so re-applying a semantically identical value (e.g. undo/redo replaying a
 *  step, or a panel re-dispatching its current value) returns the ORIGINAL
 *  document reference instead of a fresh clone. `applyWithHistory`'s no-op
 *  detection is reference-based (`next === history.present`), so without
 *  this a semantic no-op still pushed a fake undo step. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Text-layer ripple (Phase B hardening, fix 2) ──────────────────────────
//
// `studioEdits.textLayers[i].startSec`/`endSec` are captured in EDITED-
// timeline seconds at creation time (see video-preview.tsx, which compares
// them directly against the playback clock's own edited time). A delete or
// revert BEFORE a layer shifts every kept frame after it — the layer's
// underlying footage moves, but nothing previously rebased the layer's own
// timing to follow, so the preview compared stale edited seconds against a
// timeline that had already shifted under it (and the worker's own burn-in
// clamp masked the symptom at render time instead of fixing it at the
// source). Doing this in the REDUCER — not a component effect — is what
// makes it undoable: every `EditorDocument` in history already carries its
// own consistent (window, deletedRanges, textLayers) triple, so undo/redo
// simply swap back to a snapshot where the rebase was already correct for
// that state, no separate replay needed.
//
// A layer whose entire window collapses inside a brand-new cut has nowhere
// non-destructive to go: dropping it would silently delete user content as
// a side effect of an unrelated edit, so instead it CLAMPS to a minimum
// visible duration at the nearest kept instant (Vizard's own editor keeps a
// repositioned overlay on screen rather than deleting it out from under the
// user). 0.5s is long enough to read as an intentional cue, short enough
// that a clamped sliver can't meaningfully crowd out a neighboring one.
const REBASED_TEXT_LAYER_MIN_DURATION_SEC = 0.5;

/**
 * Rebases every text layer's `startSec`/`endSec` from `oldMap`'s edited
 * timeline to `newMap`'s, via the one legitimate path (edited → absolute
 * source → edited): each timestamp is resolved to the absolute source
 * second it always meant, then re-projected onto the NEW edited timeline —
 * so a layer keeps pointing at the same underlying footage regardless of
 * what shifted around it. Returns the input array unchanged (same
 * reference) when nothing actually moves, so the no-op guards in
 * `applyEditorAction`'s callers keep working.
 */
function rebaseTextLayers(
  layers: StudioTextLayer[],
  oldMap: EditedTimeMap,
  newMap: EditedTimeMap,
): StudioTextLayer[] {
  if (layers.length === 0) return layers;
  const newDurationSec = newMap.editedDurationSec;

  let changed = false;
  const rebased = layers.map((layer) => {
    const sourceStartSec = editedToSource(oldMap, layer.startSec);
    let nextStart = Math.min(newDurationSec, sourceToEdited(newMap, sourceStartSec));

    let nextEnd = layer.endSec;
    if (layer.endSec != null) {
      const sourceEndSec = editedToSource(oldMap, layer.endSec);
      nextEnd = Math.min(newDurationSec, sourceToEdited(newMap, sourceEndSec));

      // Collapsed entirely inside a new cut (or just squeezed too thin by
      // one) — clamp to the minimum floor, pulling the start back first if
      // there isn't enough room ahead of it.
      if (nextEnd - nextStart < REBASED_TEXT_LAYER_MIN_DURATION_SEC) {
        nextEnd = Math.min(newDurationSec, nextStart + REBASED_TEXT_LAYER_MIN_DURATION_SEC);
        nextStart = Math.max(0, nextEnd - REBASED_TEXT_LAYER_MIN_DURATION_SEC);
      }
    }

    if (nextStart === layer.startSec && nextEnd === layer.endSec) return layer;
    changed = true;
    return { ...layer, startSec: nextStart, endSec: nextEnd };
  });

  return changed ? rebased : layers;
}

/** Applies `rebaseTextLayers` to `doc.studioEdits.textLayers` and folds the
 *  result back into a (possibly-unchanged-reference) `studioEdits`, so
 *  callers can spread it into the next document without an extra branch. */
function rebaseStudioEdits(
  doc: EditorDocument,
  oldWindow: ClipWindow,
  oldDeletedRanges: SourceRange[],
  newWindow: ClipWindow,
  newDeletedRanges: SourceRange[],
) {
  const oldMap = buildEditedTimeMap(oldDeletedRanges, oldWindow);
  const newMap = buildEditedTimeMap(newDeletedRanges, newWindow);
  const textLayers = rebaseTextLayers(doc.studioEdits.textLayers, oldMap, newMap);
  return textLayers === doc.studioEdits.textLayers
    ? doc.studioEdits
    : { ...doc.studioEdits, textLayers };
}

/** Pure reducer: every studio mutation flows through here. */
export function applyEditorAction(
  doc: EditorDocument,
  action: EditorAction,
): EditorDocument {
  switch (action.type) {
    case "setCaptionPreset":
      return jsonEqual(action.captionPreset, doc.captionPreset)
        ? doc
        : { ...doc, captionPreset: action.captionPreset };
    case "setTranscriptSlice":
      return jsonEqual(action.transcriptSlice, doc.transcriptSlice)
        ? doc
        : { ...doc, transcriptSlice: action.transcriptSlice };
    case "updateWordText": {
      const utterance = doc.transcriptSlice[action.utteranceIndex];
      const word = utterance?.words[action.wordIndex];
      if (!utterance || !word) return doc;
      // Phase B step 10: change ONLY this word's text and rebuild the
      // utterance text — never redistribute the other words' timings.
      const words = utterance.words.map((w, i) =>
        i === action.wordIndex ? { ...w, word: action.text } : w,
      );
      const updated = {
        ...utterance,
        words,
        text: words.map((w) => w.word.trim()).filter(Boolean).join(" "),
      };
      return {
        ...doc,
        transcriptSlice: doc.transcriptSlice.map((u, i) =>
          i === action.utteranceIndex ? updated : u,
        ),
      };
    }
    case "setStudioEdits":
      return jsonEqual(action.studioEdits, doc.studioEdits)
        ? doc
        : { ...doc, studioEdits: action.studioEdits };
    case "setBrollUrl":
      return action.brollUrl === doc.brollUrl
        ? doc
        : { ...doc, brollUrl: action.brollUrl };
    case "deleteRange": {
      const window = documentWindow(doc);
      const deletedRanges = normalizeDeletedRanges(
        [...doc.deletedRanges, action.range],
        window,
      );
      if (jsonEqual(deletedRanges, doc.deletedRanges)) return doc;
      // Fix 2: a delete can shift every kept frame after it — rebase any
      // text layers so their edited-timeline timing keeps pointing at the
      // same underlying footage (see rebaseTextLayers's doc comment).
      const studioEdits = rebaseStudioEdits(doc, window, doc.deletedRanges, window, deletedRanges);
      return { ...doc, deletedRanges, studioEdits };
    }
    case "revertRange": {
      const window = documentWindow(doc);
      const deletedRanges = subtractDeletedRange(doc.deletedRanges, action.range, window);
      if (jsonEqual(deletedRanges, doc.deletedRanges)) return doc;
      const studioEdits = rebaseStudioEdits(doc, window, doc.deletedRanges, window, deletedRanges);
      return { ...doc, deletedRanges, studioEdits };
    }
    case "setDeletedRanges": {
      const window = documentWindow(doc);
      const deletedRanges = normalizeDeletedRanges(action.ranges, window);
      if (jsonEqual(deletedRanges, doc.deletedRanges)) return doc;
      const studioEdits = rebaseStudioEdits(doc, window, doc.deletedRanges, window, deletedRanges);
      return { ...doc, deletedRanges, studioEdits };
    }
    case "setClipBoundaries": {
      if (action.startSec === doc.clipStartSec && action.endSec === doc.clipEndSec) {
        return doc;
      }
      const oldWindow = documentWindow(doc);
      const newWindow = { startSec: action.startSec, endSec: action.endSec };
      // Rebase deletions into the new window so trim can never leave cuts
      // dangling outside the clip.
      const deletedRanges = normalizeDeletedRanges(doc.deletedRanges, newWindow);
      // Fix 2: the window itself moving (not just deletedRanges) can shift
      // every text layer's rebased edited position too — same rebase used
      // by the delete/revert branches, just against the new window as well
      // as any deletedRanges renormalization it forced.
      const studioEdits = rebaseStudioEdits(
        doc,
        oldWindow,
        doc.deletedRanges,
        newWindow,
        deletedRanges,
      );
      return {
        ...doc,
        clipStartSec: action.startSec,
        clipEndSec: action.endSec,
        deletedRanges,
        studioEdits,
      };
    }
    case "trimClip": {
      // Vizard-parity Phase B step 13 (in-studio trim): the composite action
      // a boundary-changing trim commit dispatches — ONE history frame for
      // what is really two related mutations (the window AND the
      // transcriptSlice that has to describe it), so undo restores both
      // together instead of leaving a half-trimmed document reachable
      // mid-stack. Internally this is exactly `setClipBoundaries` plus
      // `setTranscriptSlice`'s own logic (deletedRanges renormalized into
      // the new window, text layers rebased through it) — no new rebase
      // rules, just applied atomically.
      const boundariesChanged =
        action.startSec !== doc.clipStartSec || action.endSec !== doc.clipEndSec;
      const transcriptChanged = !jsonEqual(action.transcriptSlice, doc.transcriptSlice);
      if (!boundariesChanged && !transcriptChanged) return doc;

      const oldWindow = documentWindow(doc);
      const newWindow = { startSec: action.startSec, endSec: action.endSec };
      const deletedRanges = normalizeDeletedRanges(doc.deletedRanges, newWindow);
      const studioEdits = rebaseStudioEdits(
        doc,
        oldWindow,
        doc.deletedRanges,
        newWindow,
        deletedRanges,
      );
      return {
        ...doc,
        clipStartSec: action.startSec,
        clipEndSec: action.endSec,
        transcriptSlice: action.transcriptSlice,
        deletedRanges,
        studioEdits,
      };
    }
    case "reset":
      return action.original;
  }
}

export interface EditorHistory {
  past: EditorDocument[];
  present: EditorDocument;
  future: EditorDocument[];
  /** Coalescing key of the entry on top of `past` (slider drags, canvas drags). */
  lastCoalesceKey: string | null;
}

export const EDITOR_HISTORY_LIMIT = 100;

export function createEditorHistory(doc: EditorDocument): EditorHistory {
  return { past: [], present: doc, future: [], lastCoalesceKey: null };
}

/**
 * Apply an action, recording history. Passing the same `coalesceKey` as the
 * previous apply collapses the two into one undo step (continuous gestures);
 * any other key — or none — starts a new step.
 */
export function applyWithHistory(
  history: EditorHistory,
  action: EditorAction,
  options?: { coalesceKey?: string },
): EditorHistory {
  const next = applyEditorAction(history.present, action);
  if (next === history.present) return history;

  const coalesceKey = options?.coalesceKey ?? null;
  const coalesce =
    coalesceKey !== null && coalesceKey === history.lastCoalesceKey;

  const past = coalesce
    ? history.past
    : [...history.past, history.present].slice(-EDITOR_HISTORY_LIMIT);

  return { past, present: next, future: [], lastCoalesceKey: coalesceKey };
}

export function canUndo(history: EditorHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: EditorHistory): boolean {
  return history.future.length > 0;
}

export function undoEditor(history: EditorHistory): EditorHistory {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    lastCoalesceKey: null,
  };
}

export function redoEditor(history: EditorHistory): EditorHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present].slice(-EDITOR_HISTORY_LIMIT),
    present: next,
    future: history.future.slice(1),
    lastCoalesceKey: null,
  };
}
