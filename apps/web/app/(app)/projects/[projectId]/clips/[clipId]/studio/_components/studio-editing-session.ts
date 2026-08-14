import type { EditorAction, EditorDocument } from "@narriflow/validators";
import {
  applyUnifiedEditorAction,
  canRedoUnified,
  canUndoUnified,
  createUnifiedEditorHistory,
  type UnifiedEditorHistory,
} from "./unified-editor-history";
import type { TimelineSegment } from "./studio-types";

type Listener = () => void;
type Scalar = bigint | boolean | null | number | string | symbol | undefined;
export type DeepReadonly<T> = T extends Scalar
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };
type SynchronousEditorAction = Exclude<
  EditorAction,
  { type: "reset" | "setClipBoundaries" | "trimClip" }
>;

/** The ticket-01 projection. Later tickets extend this snapshot only when
 * their protocol moves, avoiding two owners during the migration. */
export interface StudioSessionSnapshot {
  document: DeepReadonly<EditorDocument>;
  segments: readonly DeepReadonly<TimelineSegment>[];
  history: {
    canUndo: boolean;
    canRedo: boolean;
  };
}

export type StudioSessionIntent =
  | {
      type: "document.edit";
      action: SynchronousEditorAction;
      coalesceKey?: string;
    }
  | { type: "segments.replace"; segments: TimelineSegment[] }
  | { type: "gesture.end" }
  | { type: "history.undo" }
  | { type: "history.redo" };

export type IntentReceipt = { accepted: true };

/** Typed operation surface agreed by the ADR. Ticket 01 establishes the
 * boundary; the owning behavior arrives with the corresponding ticket. */
export type StudioSessionOperation =
  | { type: "trim"; startSec: number; endSec: number }
  | { type: "prepare-cloud-revision" }
  | { type: "take-over" }
  | { type: "resolve-conflict"; choice: "device" | "cloud" }
  | { type: "reset-to-original" }
  | { type: "close"; reason: "unmount" | "navigation" | "pagehide" };

export type StudioOperationResult = {
  kind: "unavailable";
  reason: "not-implemented";
};

export interface StudioEditingSession {
  getSnapshot(): StudioSessionSnapshot;
  subscribe(listener: Listener): () => void;
  dispatch(intent: StudioSessionIntent): IntentReceipt;
  perform(operation: StudioSessionOperation): Promise<StudioOperationResult>;
}

export interface StudioSessionRoot {
  document: EditorDocument;
  segments: TimelineSegment[];
}

export type StudioSessionSeed = StudioSessionRoot;

/**
 * Temporary seam used only while the legacy React protocols move behind the
 * session one ticket at a time. It is deliberately absent from the public
 * StudioEditingSession object.
 */
export interface StudioEditingSessionMigrationAdapter {
  editDocumentAndResegment(input: {
    action: EditorAction;
    segments: TimelineSegment[];
  }): void;
  replaceRuntimeRoot(input: StudioSessionRoot): void;
  acknowledgeCloud(input: {
    expectedDocument: EditorDocument;
    document: EditorDocument;
  }): void;
}

function snapshotFor(unified: UnifiedEditorHistory): StudioSessionSnapshot {
  return deepFreeze({
    document: unified.doc.present as DeepReadonly<EditorDocument>,
    segments: unified.segments,
    history: {
      canUndo: canUndoUnified(unified),
      canRedo: canRedoUnified(unified),
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function ownDocument(document: EditorDocument): EditorDocument {
  return deepFreeze(structuredClone(document));
}

function ownSegments(segments: readonly TimelineSegment[]): TimelineSegment[] {
  return deepFreeze(structuredClone(segments)) as TimelineSegment[];
}

function snapshotsObservablyEqual(
  left: StudioSessionSnapshot,
  right: StudioSessionSnapshot,
): boolean {
  return (
    left.document === right.document &&
    left.segments === right.segments &&
    left.history.canUndo === right.history.canUndo &&
    left.history.canRedo === right.history.canRedo
  );
}

class StudioEditingSessionImplementation implements StudioEditingSession {
  private readonly listeners = new Set<Listener>();
  private unified: UnifiedEditorHistory;
  private snapshot: StudioSessionSnapshot;

  constructor(seed: StudioSessionSeed) {
    this.unified = createUnifiedEditorHistory(
      ownDocument(seed.document),
      ownSegments(seed.segments),
    );
    this.snapshot = snapshotFor(this.unified);
  }

  getSnapshot = (): StudioSessionSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch = (intent: StudioSessionIntent): IntentReceipt => {
    switch (intent.type) {
      case "document.edit":
        this.unified = applyUnifiedEditorAction(this.unified, {
          kind: "document",
          action: structuredClone(intent.action),
          coalesceKey: intent.coalesceKey,
        });
        deepFreeze(this.unified.doc.present);
        break;
      case "segments.replace":
        this.unified = applyUnifiedEditorAction(this.unified, {
          kind: "segments",
          segments: ownSegments(intent.segments),
        });
        break;
      case "gesture.end":
        this.unified = applyUnifiedEditorAction(this.unified, { kind: "endCoalesce" });
        break;
      case "history.undo":
        this.unified = applyUnifiedEditorAction(this.unified, { kind: "undo" });
        break;
      case "history.redo":
        this.unified = applyUnifiedEditorAction(this.unified, { kind: "redo" });
        break;
    }

    this.publish();
    return { accepted: true };
  };

  perform = (operation: StudioSessionOperation): Promise<StudioOperationResult> => {
    void operation;
    return Promise.resolve({ kind: "unavailable", reason: "not-implemented" });
  };

  editDocumentAndResegment(input: {
    action: EditorAction;
    segments: TimelineSegment[];
  }): void {
    this.unified = applyUnifiedEditorAction(this.unified, {
      kind: "document",
      action: structuredClone(input.action),
    });
    deepFreeze(this.unified.doc.present);
    this.unified = applyUnifiedEditorAction(this.unified, {
      kind: "resegment",
      segments: ownSegments(input.segments),
    });
    this.publish();
  }

  replaceRuntimeRoot(input: StudioSessionRoot): void {
    this.unified = createUnifiedEditorHistory(
      ownDocument(input.document),
      ownSegments(input.segments),
    );
    this.publish();
  }

  acknowledgeCloud(input: {
    expectedDocument: EditorDocument;
    document: EditorDocument;
  }): void {
    if (this.unified.doc.present !== input.expectedDocument) return;
    this.unified = {
      ...this.unified,
      doc: { ...this.unified.doc, present: ownDocument(input.document) },
    };
    this.publish();
  }

  private publish(): void {
    const next = snapshotFor(this.unified);
    if (snapshotsObservablyEqual(next, this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

const migrationAdapters = new WeakMap<
  StudioEditingSession,
  StudioEditingSessionImplementation
>();

export function createStudioEditingSession(seed: StudioSessionSeed): StudioEditingSession {
  const implementation = new StudioEditingSessionImplementation(seed);
  const session: StudioEditingSession = {
    getSnapshot: implementation.getSnapshot,
    subscribe: implementation.subscribe,
    dispatch: implementation.dispatch,
    perform: implementation.perform,
  };
  migrationAdapters.set(session, implementation);
  return session;
}

export function getStudioEditingSessionMigrationAdapter(
  session: StudioEditingSession,
): StudioEditingSessionMigrationAdapter {
  const adapter = migrationAdapters.get(session);
  if (!adapter) throw new Error("Studio session was not created by this module");
  return adapter;
}
