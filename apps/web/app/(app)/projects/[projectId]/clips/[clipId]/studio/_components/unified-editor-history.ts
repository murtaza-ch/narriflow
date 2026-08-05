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
  /** Breaks the document's coalesce chain without recording an undo step —
   *  dispatched on gesture end (slider pointer-up, drag end) so the NEXT
   *  gesture never accidentally merges into a step that already finished. */
  | { kind: "endCoalesce" }
  /**
   * Silently replaces `segments` with a freshly-rebuilt array and clears
   * their own undo history — vizard-parity.md Phase B step 13 (in-studio
   * trim): a trim's document-level undo step already covers bounds/slice/
   * ranges/textLayers (see the `trimClip` composite action in
   * @narriflow/validators); `segments` are re-derived alongside it as part
   * of the SAME user gesture, not a separate edit, so this does NOT push a
   * `metaUndo` entry — pressing ⌘Z once after a trim undoes the trim, not
   * "undo the resegment, then undo the trim". Manual splits from BEFORE the
   * trim are discarded (their old offsets no longer describe anything
   * meaningful once the window itself moved) along with their own
   * split/delete undo history, which is why `segmentsPast`/`segmentsFuture`
   * are cleared here too — an old "undo the split" now has nothing
   * consistent to restore to. For the same reason `metaUndo`/`metaRedo`
   * (Phase B closing review finding 4) must have every `"segments"` tag
   * purged from BOTH stacks here too — those tags point at exactly the
   * `segmentsPast`/`segmentsFuture` frames just cleared, so left in place a
   * later ⌘Z that reaches one hits a tag with an empty stack behind it,
   * no-ops (via the `if (!previousSegments) return state;` guard below), and
   * permanently wedges undo at that point instead of falling through to the
   * next real step. `"document"` tags (and their relative order) are left
   * untouched — the trim's own document-level undo step must still pop
   * normally.
   */
  | { kind: "resegment"; segments: TimelineSegment[] }
  | { kind: "undo" }
  | { kind: "redo" };

/** Clears the document history's coalesce key if it's set, otherwise returns
 *  the same reference (keeps callers that don't need to break the chain
 *  cheap/no-op). Shared by the "segments" and "endCoalesce" cases below. */
function clearDocCoalesce(doc: EditorHistory): EditorHistory {
  return doc.lastCoalesceKey === null ? doc : { ...doc, lastCoalesceKey: null };
}

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
      // slider drag doesn't spuriously grow the meta stack either. Detect
      // "did this push a new past frame" via reference INEQUALITY, not
      // length growth — length stops growing once EDITOR_HISTORY_LIMIT is
      // hit, but applyWithHistory's push path always allocates a fresh
      // `past` array (even at the cap, via `.slice()`), while its coalesce
      // path reuses the same array — see editor-document.test.ts's
      // "reference, even at the cap" tests for the pinned-down contract.
      if (nextDoc === state.doc) return state;
      const pushedFrame = nextDoc.past !== state.doc.past;
      return {
        ...state,
        doc: nextDoc,
        metaUndo: pushedFrame ? [...state.metaUndo, "document"] : state.metaUndo,
        metaRedo: [],
      };
    }
    case "segments": {
      return {
        ...state,
        // A segment split/delete is its own undo step — it must not let a
        // caption/slider gesture that was mid-coalesce before it (or after
        // it, if the same coalesceKey happens to repeat) silently merge
        // across the segment mutation.
        doc: clearDocCoalesce(state.doc),
        segmentsPast: [...state.segmentsPast, state.segments],
        segments: action.segments,
        segmentsFuture: [],
        metaUndo: [...state.metaUndo, "segments"],
        metaRedo: [],
      };
    }
    case "endCoalesce": {
      const nextDoc = clearDocCoalesce(state.doc);
      return nextDoc === state.doc ? state : { ...state, doc: nextDoc };
    }
    case "resegment": {
      return {
        ...state,
        segments: action.segments,
        segmentsPast: [],
        segmentsFuture: [],
        metaUndo: state.metaUndo.filter((tag) => tag !== "segments"),
        metaRedo: state.metaRedo.filter((tag) => tag !== "segments"),
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
