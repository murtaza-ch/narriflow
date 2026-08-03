import {
  applyWithHistory,
  canRedo as canRedoDoc,
  canUndo as canUndoDoc,
  createEditorHistory,
  redoEditor,
  undoEditor,
  type EditorAction,
  type EditorDocument,
  type EditorHistory,
} from "@narriflow/validators";
import type { TimelineSegment } from "./studio-shell";

/**
 * Unified undo/redo (vizard-parity.md Phase A step 3): the studio has two
 * independently-managed undo mechanisms — the revisioned `EditorDocument`'s
 * own past/future (`EditorHistory`, see @narriflow/validators) and the
 * timeline's client-only segment splits/deletes (never persisted). ⌘Z must
 * pop whichever one happened LAST, not always the document. Rather than
 * merging the two histories into one array (the document's `past` holds full
 * `EditorDocument` snapshots; segments hold `TimelineSegment[]` — different
 * shapes with different undo semantics), this keeps both stacks as they are
 * and layers a "which stack does the next pop come from" ordering on top,
 * tagged per mutation kind. Pure and side-effect-free so it's unit-testable
 * without React.
 */
export type EditorHistoryKind = "document" | "segments";

export interface UnifiedEditorHistory {
  doc: EditorHistory;
  segments: TimelineSegment[];
  segmentsPast: TimelineSegment[][];
  segmentsFuture: TimelineSegment[][];
  /** Chronological order of undoable mutations, oldest first. */
  metaUndo: EditorHistoryKind[];
  metaRedo: EditorHistoryKind[];
}

export type UnifiedEditorAction =
  | { kind: "document"; action: EditorAction; coalesceKey?: string }
  | { kind: "segments"; segments: TimelineSegment[] }
  | { kind: "undo" }
  | { kind: "redo" };

export function createUnifiedEditorHistory(
  document: EditorDocument,
  segments: TimelineSegment[],
): UnifiedEditorHistory {
  return {
    doc: createEditorHistory(document),
    segments,
    segmentsPast: [],
    segmentsFuture: [],
    metaUndo: [],
    metaRedo: [],
  };
}

export function applyUnifiedEditorAction(
  state: UnifiedEditorHistory,
  action: UnifiedEditorAction,
): UnifiedEditorHistory {
  switch (action.kind) {
    case "document": {
      const nextDoc = applyWithHistory(state.doc, action.action, {
        coalesceKey: action.coalesceKey,
      });
      // applyWithHistory returns the same reference for a no-op (including a
      // coalesced continuation of the current step) — mirror that here so a
      // slider drag doesn't spuriously grow the meta stack either.
      if (nextDoc === state.doc) return state;
      const grewPast = nextDoc.past.length > state.doc.past.length;
      return {
        ...state,
        doc: nextDoc,
        metaUndo: grewPast ? [...state.metaUndo, "document"] : state.metaUndo,
        metaRedo: [],
      };
    }
    case "segments": {
      return {
        ...state,
        segmentsPast: [...state.segmentsPast, state.segments],
        segments: action.segments,
        segmentsFuture: [],
        metaUndo: [...state.metaUndo, "segments"],
        metaRedo: [],
      };
    }
    case "undo": {
      const tag = state.metaUndo[state.metaUndo.length - 1];
      if (!tag) return state;
      if (tag === "document") {
        return {
          ...state,
          doc: undoEditor(state.doc),
          metaUndo: state.metaUndo.slice(0, -1),
          metaRedo: [tag, ...state.metaRedo],
        };
      }
      const previousSegments = state.segmentsPast[state.segmentsPast.length - 1];
      if (!previousSegments) return state;
      return {
        ...state,
        segments: previousSegments,
        segmentsPast: state.segmentsPast.slice(0, -1),
        segmentsFuture: [state.segments, ...state.segmentsFuture],
        metaUndo: state.metaUndo.slice(0, -1),
        metaRedo: [tag, ...state.metaRedo],
      };
    }
    case "redo": {
      const tag = state.metaRedo[0];
      if (!tag) return state;
      if (tag === "document") {
        return {
          ...state,
          doc: redoEditor(state.doc),
          metaUndo: [...state.metaUndo, tag],
          metaRedo: state.metaRedo.slice(1),
        };
      }
      const nextSegments = state.segmentsFuture[0];
      if (!nextSegments) return state;
      return {
        ...state,
        segments: nextSegments,
        segmentsPast: [...state.segmentsPast, state.segments],
        segmentsFuture: state.segmentsFuture.slice(1),
        metaUndo: [...state.metaUndo, tag],
        metaRedo: state.metaRedo.slice(1),
      };
    }
  }
}

export function canUndoUnified(state: UnifiedEditorHistory): boolean {
  return state.metaUndo.length > 0;
}

export function canRedoUnified(state: UnifiedEditorHistory): boolean {
  return state.metaRedo.length > 0;
}

// Re-exported so call sites that only care about the document side (e.g. a
// future "is the document itself dirty" check) don't need a second import.
export { canUndoDoc, canRedoDoc };
