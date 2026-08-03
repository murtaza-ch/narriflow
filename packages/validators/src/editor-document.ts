import { z } from "zod";

import { captionPresetSchema } from "./caption-preset";
import {
  deletedRangesSchema,
  normalizeDeletedRanges,
  sourceRangeSchema,
  subtractDeletedRange,
} from "./edit-ranges";
import { studioEditsSchema } from "./studio-edits";
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
  z.object({ type: z.literal("reset"), original: editorDocumentSchema }),
]);

export type EditorAction = z.infer<typeof editorActionSchema>;

function documentWindow(doc: EditorDocument) {
  return { startSec: doc.clipStartSec, endSec: doc.clipEndSec };
}

/** Pure reducer: every studio mutation flows through here. */
export function applyEditorAction(
  doc: EditorDocument,
  action: EditorAction,
): EditorDocument {
  switch (action.type) {
    case "setCaptionPreset":
      return { ...doc, captionPreset: action.captionPreset };
    case "setTranscriptSlice":
      return { ...doc, transcriptSlice: action.transcriptSlice };
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
      return { ...doc, studioEdits: action.studioEdits };
    case "setBrollUrl":
      return { ...doc, brollUrl: action.brollUrl };
    case "deleteRange":
      return {
        ...doc,
        deletedRanges: normalizeDeletedRanges(
          [...doc.deletedRanges, action.range],
          documentWindow(doc),
        ),
      };
    case "revertRange":
      return {
        ...doc,
        deletedRanges: subtractDeletedRange(
          doc.deletedRanges,
          action.range,
          documentWindow(doc),
        ),
      };
    case "setDeletedRanges":
      return {
        ...doc,
        deletedRanges: normalizeDeletedRanges(action.ranges, documentWindow(doc)),
      };
    case "setClipBoundaries": {
      const next = {
        ...doc,
        clipStartSec: action.startSec,
        clipEndSec: action.endSec,
      };
      // Rebase deletions into the new window so trim can never leave cuts
      // dangling outside the clip.
      next.deletedRanges = normalizeDeletedRanges(next.deletedRanges, {
        startSec: action.startSec,
        endSec: action.endSec,
      });
      return next;
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
