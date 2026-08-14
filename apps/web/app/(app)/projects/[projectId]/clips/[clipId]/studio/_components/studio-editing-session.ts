import type { EditorAction, EditorDocument } from "@narriflow/validators";
import {
  applyUnifiedEditorAction,
  canRedoUnified,
  canUndoUnified,
  createUnifiedEditorHistory,
  type UnifiedEditorHistory,
} from "./unified-editor-history";
import type { TimelineSegment } from "./studio-types";
import {
  decideDraftRecovery,
  LOCAL_DRAFT_WRITE_DEBOUNCE_MS,
  type StoredEditorDraft,
} from "./local-editor-draft";

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
  status: "starting" | "ready" | "conflict" | "closed";
  recovery: {
    kind: "none" | "recovered" | "merged" | "conflict";
    conflictPaths: readonly string[];
  };
  durability: {
    device: "durable" | "pending" | "degraded";
    protectsNavigation: boolean;
  };
  ownership: {
    kind: "pending" | "writer" | "reader" | "degraded";
    generation: number | null;
  };
  capabilities: {
    mutate: boolean;
    play: boolean;
    takeOver: boolean;
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

export type IntentReceipt =
  | { accepted: true }
  | { accepted: false; reason: "starting" | "read-only" | "conflict" | "closed" };

/** Typed operation surface agreed by the ADR. Ticket 01 establishes the
 * boundary; the owning behavior arrives with the corresponding ticket. */
export type StudioSessionOperation =
  | { type: "start" }
  | { type: "trim"; startSec: number; endSec: number }
  | { type: "prepare-cloud-revision" }
  | { type: "take-over" }
  | { type: "resolve-conflict"; choice: "device" | "cloud" }
  | { type: "reset-to-original" }
  | { type: "close"; reason: "unmount" | "navigation" | "pagehide" };

export type StudioOperationResult =
  | { kind: "unavailable"; reason: "not-implemented" | "invalid-state" }
  | { kind: "started" }
  | { kind: "closed" }
  | { kind: "conflict-resolved"; choice: "device" | "cloud" }
  | {
      kind: "ownership-acquired";
      forced: boolean;
      cloudRevision: number;
      cloudDocument: DeepReadonly<EditorDocument>;
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

export interface StudioSessionIdentity {
  projectId: string;
  clipId: string;
}

export interface StudioSessionSeed
  extends StudioSessionRoot,
    Partial<StudioSessionIdentity> {
  cloudRevision?: number;
}

export interface StudioSessionOptions {
  deferStart?: boolean;
}

export type StudioDraftRecord = StoredEditorDraft;

export interface StudioCoordinationParticipant {
  onTakeoverRequested(): Promise<"checkpointed" | "unavailable">;
  onOwnershipLost(): void;
}

export interface StudioSessionDependencies {
  drafts: {
    load(key: string): Promise<StudioDraftRecord | null>;
    write(record: StudioDraftRecord): Promise<"written" | "stale">;
    remove(key: string, ownershipGeneration: number): Promise<"removed" | "stale">;
  };
  coordination: {
    start(participant: StudioCoordinationParticipant): Promise<
      | { kind: "writer"; generation: number }
      | { kind: "reader"; generation: number }
      | { kind: "degraded"; generation: number }
    >;
    takeOver(timeoutMs: number): Promise<
      | { kind: "acquired"; generation: number; forced: boolean }
      | { kind: "failed" }
    >;
    relinquish?(): void;
    close(): void;
  };
  cloud: {
    loadHead(): Promise<{ revision: number; document: EditorDocument }>;
  };
  runtime: {
    now(): number;
    createId(): string;
    setTimeout(callback: () => void, delayMs: number): number;
    clearTimeout(id: number): void;
  };
}

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
  replaceRuntimeRoot(
    input: StudioSessionRoot & {
      cloudBaseline?: { revision: number; document: EditorDocument };
    },
  ): void;
  acknowledgeCloud(input: {
    expectedDocument: EditorDocument;
    document: EditorDocument;
    revision?: number;
  }): Promise<void>;
}

interface SessionProjection {
  status: StudioSessionSnapshot["status"];
  recovery: StudioSessionSnapshot["recovery"];
  durability: StudioSessionSnapshot["durability"];
  ownership: StudioSessionSnapshot["ownership"];
}

type DeviceDraftCheckpointOutcome = "checkpointed" | "stale" | "unavailable";
type DraftFenceOutcome = "fenced" | "stale" | "unavailable";
type DraftLoadResult =
  | { kind: "loaded"; draft: StudioDraftRecord | null }
  | { kind: "failed"; draft: null; error: string };

function snapshotFor(
  unified: UnifiedEditorHistory,
  projection: SessionProjection,
): StudioSessionSnapshot {
  const mutate =
    projection.status === "ready" &&
    (projection.ownership.kind === "writer" || projection.ownership.kind === "degraded");
  return deepFreeze({
    document: unified.doc.present as DeepReadonly<EditorDocument>,
    segments: unified.segments,
    history: {
      canUndo: canUndoUnified(unified),
      canRedo: canRedoUnified(unified),
    },
    ...projection,
    capabilities: {
      mutate,
      play: projection.status !== "closed",
      takeOver:
        projection.status !== "closed" && projection.ownership.kind === "reader",
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
    left.history.canRedo === right.history.canRedo &&
    left.status === right.status &&
    left.recovery.kind === right.recovery.kind &&
    left.recovery.conflictPaths === right.recovery.conflictPaths &&
    left.durability.device === right.durability.device &&
    left.durability.protectsNavigation === right.durability.protectsNavigation &&
    left.ownership.kind === right.ownership.kind &&
    left.ownership.generation === right.ownership.generation
  );
}

class StudioEditingSessionImplementation implements StudioEditingSession {
  private readonly listeners = new Set<Listener>();
  private unified: UnifiedEditorHistory;
  private snapshot: StudioSessionSnapshot;
  private projection: SessionProjection;
  private readonly dependencies?: StudioSessionDependencies;
  private readonly seed: StudioSessionSeed;
  private readonly identity: StudioSessionIdentity | null;
  private readonly writerId: string;
  private cloudDocument: EditorDocument;
  private cloudRevision: number;
  private deviceDraftAvailable = true;
  private draftWriteTimer: number | null = null;
  private draftWriteChain: Promise<DeviceDraftCheckpointOutcome> = Promise.resolve(
    "checkpointed",
  );
  private pendingConflict: {
    deviceDocument: EditorDocument;
    cloudDocument: EditorDocument;
  } | null = null;
  private started: boolean;
  private sessionGeneration = 0;

  constructor(
    seed: StudioSessionSeed,
    dependencies?: StudioSessionDependencies,
    options: StudioSessionOptions = {},
  ) {
    this.seed = seed;
    this.dependencies = dependencies;
    if (dependencies && (!seed.projectId || !seed.clipId)) {
      throw new Error("Durable Studio sessions require a project and clip identity");
    }
    this.identity =
      seed.projectId && seed.clipId
        ? { projectId: seed.projectId, clipId: seed.clipId }
        : null;
    this.writerId = dependencies?.runtime.createId() ?? "standalone-session";
    this.cloudDocument = ownDocument(seed.document);
    this.cloudRevision = seed.cloudRevision ?? 0;
    this.unified = createUnifiedEditorHistory(
      ownDocument(seed.document),
      ownSegments(seed.segments),
    );
    this.projection = dependencies
      ? {
          status: "starting",
          recovery: { kind: "none", conflictPaths: [] },
          durability: { device: "pending", protectsNavigation: true },
          ownership: { kind: "pending", generation: null },
        }
      : {
          status: "ready",
          recovery: { kind: "none", conflictPaths: [] },
          durability: { device: "durable", protectsNavigation: false },
          ownership: { kind: "writer", generation: 0 },
        };
    this.snapshot = snapshotFor(this.unified, this.projection);
    this.started = !dependencies || !options.deferStart;
    if (dependencies && this.started) void this.initialize();
  }

  getSnapshot = (): StudioSessionSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch = (intent: StudioSessionIntent): IntentReceipt => {
    if (!this.snapshot.capabilities.mutate) {
      const reason =
        this.projection.status === "starting"
          ? "starting"
          : this.projection.status === "conflict"
            ? "conflict"
            : this.projection.status === "closed"
              ? "closed"
              : "read-only";
      return { accepted: false, reason };
    }
    const documentBefore = this.unified.doc.present;
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

    if (this.unified.doc.present !== documentBefore) {
      this.scheduleDeviceDraftWrite();
    }
    this.publish();
    return { accepted: true };
  };

  perform = async (operation: StudioSessionOperation): Promise<StudioOperationResult> => {
    if (operation.type === "start") {
      if (!this.dependencies || this.started || this.projection.status === "closed") {
        return { kind: "unavailable", reason: "invalid-state" };
      }
      this.started = true;
      void this.initialize();
      return { kind: "started" };
    }
    if (operation.type === "close") {
      if (this.projection.status === "closed") {
        return { kind: "unavailable", reason: "invalid-state" };
      }
      this.sessionGeneration += 1;
      if (
        this.projection.ownership.kind === "writer" ||
        this.projection.ownership.kind === "degraded"
      ) {
        if (this.draftWriteTimer !== null && this.dependencies) {
          this.dependencies.runtime.clearTimeout(this.draftWriteTimer);
          this.draftWriteTimer = null;
        }
        await this.queueDeviceDraftCheckpoint();
      }
      this.dependencies?.coordination.close();
      this.projection = {
        ...this.projection,
        status: "closed",
        ownership: {
          kind: "reader",
          generation: this.projection.ownership.generation,
        },
      };
      this.publish();
      return { kind: "closed" };
    }
    if (operation.type === "take-over") {
      return this.takeOver();
    }
    if (operation.type !== "resolve-conflict") {
      return { kind: "unavailable", reason: "not-implemented" };
    }
    if (!this.pendingConflict || this.projection.status !== "conflict") {
      return { kind: "unavailable", reason: "invalid-state" };
    }
    const document =
      operation.choice === "device"
        ? this.pendingConflict.deviceDocument
        : this.pendingConflict.cloudDocument;
    this.unified = createUnifiedEditorHistory(
      ownDocument(document),
      ownSegments(this.seed.segments),
    );
    if (operation.choice === "cloud") {
      const generation = this.projection.ownership.generation;
      if (this.dependencies && generation !== null) {
        const key = this.deviceDraftKey;
        try {
          const outcome = await this.dependencies.drafts.remove(key, generation);
          if (outcome === "stale") {
            this.diagnose("studio_conflict_draft_remove_rejected", "stale");
            this.dependencies.coordination.relinquish?.();
            this.loseOwnership();
          }
        } catch (error) {
          this.deviceDraftAvailable = false;
          this.projection = {
            ...this.projection,
            durability: { device: "degraded", protectsNavigation: true },
          };
          this.diagnose(
            "studio_conflict_draft_remove_failed",
            "degraded",
            error,
          );
        }
      }
    }
    this.pendingConflict = null;
    this.projection = {
      ...this.projection,
      status: "ready",
      recovery: {
        kind: operation.choice === "device" ? "recovered" : "none",
        conflictPaths: [],
      },
    };
    this.publish();
    return { kind: "conflict-resolved", choice: operation.choice };
  };

  editDocumentAndResegment(input: {
    action: EditorAction;
    segments: TimelineSegment[];
  }): void {
    if (!this.snapshot.capabilities.mutate) return;
    const documentBefore = this.unified.doc.present;
    this.unified = applyUnifiedEditorAction(this.unified, {
      kind: "document",
      action: structuredClone(input.action),
    });
    deepFreeze(this.unified.doc.present);
    this.unified = applyUnifiedEditorAction(this.unified, {
      kind: "resegment",
      segments: ownSegments(input.segments),
    });
    if (this.unified.doc.present !== documentBefore) {
      this.scheduleDeviceDraftWrite();
    }
    this.publish();
  }

  replaceRuntimeRoot(
    input: StudioSessionRoot & {
      cloudBaseline?: { revision: number; document: EditorDocument };
    },
  ): void {
    const documentBefore = this.unified.doc.present;
    if (input.cloudBaseline) {
      this.cloudRevision = input.cloudBaseline.revision;
      this.cloudDocument = ownDocument(input.cloudBaseline.document);
    }
    this.unified = createUnifiedEditorHistory(
      ownDocument(input.document),
      ownSegments(input.segments),
    );
    if (this.unified.doc.present !== documentBefore) {
      this.scheduleDeviceDraftWrite();
    }
    this.publish();
  }

  async acknowledgeCloud(input: {
    expectedDocument: EditorDocument;
    document: EditorDocument;
    revision?: number;
  }): Promise<void> {
    this.cloudDocument = ownDocument(input.document);
    if (input.revision !== undefined) this.cloudRevision = input.revision;
    if (this.unified.doc.present !== input.expectedDocument) return;
    this.unified = {
      ...this.unified,
      doc: { ...this.unified.doc, present: ownDocument(input.document) },
    };
    const generation = this.projection.ownership.generation;
    if (this.dependencies && generation !== null) {
      try {
        const outcome = await this.dependencies.drafts.remove(
          this.deviceDraftKey,
          generation,
        );
        if (outcome === "stale") {
          this.diagnose("studio_cloud_ack_draft_remove_rejected", "stale");
          this.dependencies.coordination.relinquish?.();
          this.loseOwnership();
          return;
        }
        this.projection = {
          ...this.projection,
          durability: { device: "durable", protectsNavigation: false },
        };
      } catch (error) {
        this.deviceDraftAvailable = false;
        this.projection = {
          ...this.projection,
          durability: { device: "degraded", protectsNavigation: true },
        };
        this.diagnose("studio_cloud_ack_draft_remove_failed", "degraded", error);
      }
    } else {
      this.projection = {
        ...this.projection,
        durability: { device: "durable", protectsNavigation: false },
      };
    }
    this.publish();
  }

  private publish(): void {
    const next = snapshotFor(this.unified, this.projection);
    if (snapshotsObservablyEqual(next, this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private get deviceDraftKey(): string {
    if (!this.identity) throw new Error("Device Draft identity is unavailable");
    return `${this.identity.projectId}:${this.identity.clipId}`;
  }

  private diagnose(message: string, outcome: string, error?: unknown): void {
    console.warn(
      JSON.stringify({
        level: "warn",
        message,
        projectId: this.identity?.projectId,
        clipId: this.identity?.clipId,
        sessionGeneration: this.sessionGeneration,
        documentVersion: this.cloudRevision,
        ownershipGeneration: this.projection.ownership.generation,
        outcome,
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      }),
    );
  }

  private loseOwnership(): void {
    this.sessionGeneration += 1;
    if (this.draftWriteTimer !== null && this.dependencies) {
      this.dependencies.runtime.clearTimeout(this.draftWriteTimer);
      this.draftWriteTimer = null;
    }
    if (this.projection.status === "closed") return;
    this.projection = {
      ...this.projection,
      status: "ready",
      ownership: {
        kind: "reader",
        generation: this.projection.ownership.generation,
      },
    };
    this.publish();
  }

  private ownsGeneration(generation: number): boolean {
    return (
      this.projection.ownership.generation === generation &&
      (this.projection.ownership.kind === "writer" ||
        this.projection.ownership.kind === "degraded")
    );
  }

  private async initialize(): Promise<void> {
    const dependencies = this.dependencies;
    if (!dependencies) return;
    const expectedSessionGeneration = this.sessionGeneration;
    const participant: StudioCoordinationParticipant = {
      onTakeoverRequested: async () => {
        const priorOwnership = this.projection.ownership;
        if (priorOwnership.kind !== "writer" && priorOwnership.kind !== "degraded") {
          return "unavailable";
        }
        this.projection = { ...this.projection, status: "starting" };
        this.publish();
        if (this.draftWriteTimer !== null) {
          dependencies.runtime.clearTimeout(this.draftWriteTimer);
          this.draftWriteTimer = null;
        }
        const outcome = await this.queueDeviceDraftCheckpoint();
        if (outcome === "checkpointed") return "checkpointed";
        this.diagnose("studio_handoff_checkpoint_failed", outcome);
        if (this.projection.ownership.kind !== "reader") {
          this.projection = {
            ...this.projection,
            status: "ready",
            ownership: priorOwnership,
          };
          this.publish();
        }
        return "unavailable";
      },
      onOwnershipLost: () => this.loseOwnership(),
    };

    const [draftResult, ownership] = await Promise.all([
      dependencies.drafts.load(this.deviceDraftKey).then<
        DraftLoadResult,
        DraftLoadResult
      >(
        (draft) => ({ kind: "loaded", draft }),
        (error: unknown) => ({
          kind: "failed",
          draft: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
      dependencies.coordination.start(participant).catch((error: unknown) => {
        this.diagnose("studio_coordination_start_failed", "degraded", error);
        return {
          kind: "degraded" as const,
          generation: Math.max(1, dependencies.runtime.now()),
        };
      }),
    ]);
    if (this.sessionGeneration !== expectedSessionGeneration) return;
    this.projection = {
      ...this.projection,
      ownership: { kind: "pending", generation: ownership.generation },
    };
    if (ownership.kind === "reader") {
      this.deviceDraftAvailable = draftResult.kind === "loaded";
      this.projection = {
        ...this.projection,
        ownership,
      };
      if (draftResult.kind === "failed") {
        this.diagnose("studio_device_draft_load_failed", "degraded", draftResult.error);
      }
      this.projection = {
        status: "ready",
        recovery: { kind: "none", conflictPaths: [] },
        durability: this.deviceDraftAvailable
          ? { device: "durable", protectsNavigation: false }
          : { device: "degraded", protectsNavigation: true },
        ownership,
      };
      this.publish();
      return;
    }
    if (ownership.kind === "degraded") {
      this.diagnose("studio_coordination_degraded", "degraded");
    }
    const projection = await this.reconcileOwnedDraft({
      draftResult,
      cloudDocument: this.seed.document,
      cloudRevision: this.seed.cloudRevision ?? 0,
      ownershipKind: ownership.kind,
      ownershipGeneration: ownership.generation,
      expectedSessionGeneration,
    });
    if (!projection || this.sessionGeneration !== expectedSessionGeneration) return;
    this.projection = projection;
    this.publish();
  }

  private async reconcileOwnedDraft(input: {
    draftResult: DraftLoadResult;
    cloudDocument: EditorDocument;
    cloudRevision: number;
    ownershipKind: "writer" | "degraded";
    ownershipGeneration: number;
    expectedSessionGeneration: number;
  }): Promise<SessionProjection | null> {
    let ownershipGeneration = input.ownershipGeneration;
    if (
      input.draftResult.kind === "loaded" &&
      input.draftResult.draft &&
      input.draftResult.draft.writerId !== this.writerId
    ) {
      ownershipGeneration = Math.max(
        ownershipGeneration,
        input.draftResult.draft.ownershipGeneration + 1,
      );
    }

    this.deviceDraftAvailable = input.draftResult.kind === "loaded";
    if (input.draftResult.kind === "failed") {
      this.diagnose(
        "studio_device_draft_load_failed",
        "degraded",
        input.draftResult.error,
      );
    } else if (input.draftResult.draft) {
      const fence = await this.fenceLoadedDraft(
        input.draftResult.draft,
        ownershipGeneration,
      );
      if (this.sessionGeneration !== input.expectedSessionGeneration) return null;
      if (fence === "stale") {
        this.projection = {
          ...this.projection,
          ownership: { kind: "pending", generation: ownershipGeneration },
        };
        this.diagnose("studio_device_draft_fence_rejected", "stale");
        this.dependencies?.coordination.relinquish?.();
        this.loseOwnership();
        return null;
      }
      if (fence === "unavailable") {
        this.deviceDraftAvailable = false;
        this.diagnose("studio_device_draft_fence_failed", "degraded");
      }
    }

    let status: SessionProjection["status"] = "ready";
    let recovery: SessionProjection["recovery"] = {
      kind: "none",
      conflictPaths: [],
    };
    let document = input.cloudDocument;
    this.pendingConflict = null;
    if (input.draftResult.kind === "loaded") {
      const decision = decideDraftRecovery(
        input.draftResult.draft,
        input.cloudDocument,
        input.cloudRevision,
      );
      if (decision.kind === "recover") {
        document = decision.document;
        recovery = {
          kind: decision.merged ? "merged" : "recovered",
          conflictPaths: [],
        };
      } else if (decision.kind === "conflict") {
        this.pendingConflict = {
          deviceDocument: ownDocument(decision.document),
          cloudDocument: ownDocument(input.cloudDocument),
        };
        status = "conflict";
        recovery = { kind: "conflict", conflictPaths: decision.paths };
      }
    }
    this.unified = createUnifiedEditorHistory(
      ownDocument(document),
      ownSegments(this.seed.segments),
    );
    return {
      status,
      recovery,
      durability: this.deviceDraftAvailable
        ? { device: "durable", protectsNavigation: false }
        : { device: "degraded", protectsNavigation: true },
      ownership: {
        kind: input.ownershipKind,
        generation: ownershipGeneration,
      },
    };
  }

  private async takeOver(): Promise<StudioOperationResult> {
    const dependencies = this.dependencies;
    if (!dependencies || this.projection.ownership.kind !== "reader") {
      return { kind: "unavailable", reason: "invalid-state" };
    }
    const expectedSessionGeneration = this.sessionGeneration;
    this.projection = {
      ...this.projection,
      status: "starting",
      ownership: {
        kind: "pending",
        generation: this.projection.ownership.generation,
      },
    };
    this.publish();
    const acquired = await dependencies.coordination.takeOver(2_000);
    if (this.sessionGeneration !== expectedSessionGeneration) {
      return { kind: "unavailable", reason: "invalid-state" };
    }
    if (acquired.kind === "failed") {
      this.diagnose("studio_takeover_failed", "unavailable");
      this.projection = {
        ...this.projection,
        status: "ready",
        ownership: {
          kind: "reader",
          generation: this.projection.ownership.generation,
        },
      };
      this.publish();
      return { kind: "unavailable", reason: "invalid-state" };
    }
    this.projection = {
      ...this.projection,
      ownership: { kind: "pending", generation: acquired.generation },
    };

    const [cloudResult, draftResult] = await Promise.all([
      dependencies.cloud.loadHead().then(
        (head) => ({ kind: "loaded" as const, head }),
        (error: unknown) => ({
          kind: "failed" as const,
          head: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
      dependencies.drafts.load(this.deviceDraftKey).then<
        DraftLoadResult,
        DraftLoadResult
      >(
        (draft) => ({ kind: "loaded", draft }),
        (error: unknown) => ({
          kind: "failed",
          draft: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    ]);
    if (this.sessionGeneration !== expectedSessionGeneration) {
      return { kind: "unavailable", reason: "invalid-state" };
    }
    if (cloudResult.kind === "failed") {
      this.projection = {
        ...this.projection,
        ownership: { kind: "pending", generation: acquired.generation },
      };
      this.diagnose(
        "studio_takeover_cloud_refresh_failed",
        "unavailable",
        cloudResult.error,
      );
      dependencies.coordination.relinquish?.();
      this.loseOwnership();
      return { kind: "unavailable", reason: "invalid-state" };
    }

    this.cloudDocument = ownDocument(cloudResult.head.document);
    this.cloudRevision = cloudResult.head.revision;
    const projection = await this.reconcileOwnedDraft({
      draftResult,
      cloudDocument: this.cloudDocument,
      cloudRevision: this.cloudRevision,
      ownershipKind: "writer",
      ownershipGeneration: acquired.generation,
      expectedSessionGeneration,
    });
    if (!projection || this.sessionGeneration !== expectedSessionGeneration) {
      return { kind: "unavailable", reason: "invalid-state" };
    }
    this.projection = projection;
    this.publish();
    return {
      kind: "ownership-acquired",
      forced: acquired.forced,
      cloudRevision: this.cloudRevision,
      cloudDocument: this.cloudDocument,
    };
  }

  private scheduleDeviceDraftWrite(): void {
    const dependencies = this.dependencies;
    if (!dependencies || !this.deviceDraftAvailable) return;
    if (this.draftWriteTimer !== null) {
      dependencies.runtime.clearTimeout(this.draftWriteTimer);
    }
    this.projection = {
      ...this.projection,
      durability: { device: "pending", protectsNavigation: true },
    };
    this.draftWriteTimer = dependencies.runtime.setTimeout(() => {
      this.draftWriteTimer = null;
      this.queueDeviceDraftCheckpoint();
    }, LOCAL_DRAFT_WRITE_DEBOUNCE_MS);
  }

  private queueDeviceDraftCheckpoint(): Promise<DeviceDraftCheckpointOutcome> {
    this.draftWriteChain = this.draftWriteChain
      .catch((error: unknown) => {
        this.diagnose("studio_device_draft_queue_failed", "unavailable", error);
        return "unavailable" as const;
      })
      .then(() => this.checkpointDeviceDraft());
    return this.draftWriteChain;
  }

  private async checkpointDeviceDraft(): Promise<DeviceDraftCheckpointOutcome> {
    const dependencies = this.dependencies;
    const generation = this.projection.ownership.generation;
    if (!dependencies || generation === null) return "unavailable";
    const document = this.unified.doc.present;
    if (!this.deviceDraftAvailable) {
      return JSON.stringify(document) === JSON.stringify(this.cloudDocument)
        ? "checkpointed"
        : "unavailable";
    }
    const key = this.deviceDraftKey;
    try {
      if (JSON.stringify(document) === JSON.stringify(this.cloudDocument)) {
        const outcome = await dependencies.drafts.remove(key, generation);
        if (!this.ownsGeneration(generation)) return "stale";
        if (outcome === "stale") {
          this.diagnose("studio_device_draft_remove_rejected", "stale");
          dependencies.coordination.relinquish?.();
          this.loseOwnership();
          return "stale";
        } else {
          this.projection = {
            ...this.projection,
            durability: { device: "durable", protectsNavigation: false },
          };
        }
        this.publish();
        return "checkpointed";
      }
      if (!this.identity) return "unavailable";
      const outcome = await dependencies.drafts.write({
        formatVersion: 2,
        key,
        projectId: this.identity.projectId,
        clipId: this.identity.clipId,
        baseRevision: this.cloudRevision,
        baseDocument: ownDocument(this.cloudDocument),
        document: ownDocument(document),
        updatedAt: dependencies.runtime.now(),
        writerId: this.writerId,
        ownershipGeneration: generation,
      });
      if (!this.ownsGeneration(generation)) return "stale";
      if (outcome === "stale") {
        this.diagnose("studio_device_draft_write_rejected", "stale");
        dependencies.coordination.relinquish?.();
        this.loseOwnership();
        return "stale";
      } else if (this.unified.doc.present === document) {
        this.projection = {
          ...this.projection,
          durability: { device: "durable", protectsNavigation: false },
        };
      }
    } catch (error) {
      this.deviceDraftAvailable = false;
      this.projection = {
        ...this.projection,
        durability: { device: "degraded", protectsNavigation: true },
      };
      this.diagnose("studio_device_draft_checkpoint_failed", "degraded", error);
      this.publish();
      return "unavailable";
    }
    this.publish();
    return "checkpointed";
  }

  private async fenceLoadedDraft(
    draft: StudioDraftRecord,
    ownershipGeneration: number,
  ): Promise<DraftFenceOutcome> {
    const dependencies = this.dependencies;
    if (!dependencies) return "unavailable";
    if (
      draft.formatVersion === 2 &&
      draft.ownershipGeneration === ownershipGeneration &&
      draft.writerId === this.writerId
    ) {
      return "fenced";
    }
    try {
      const outcome = await dependencies.drafts.write({
        ...draft,
        formatVersion: 2,
        ownershipGeneration,
        writerId: this.writerId,
        updatedAt: dependencies.runtime.now(),
      });
      return outcome === "written" ? "fenced" : "stale";
    } catch (error) {
      this.diagnose("studio_device_draft_fence_write_failed", "unavailable", error);
      return "unavailable";
    }
  }
}

const migrationAdapters = new WeakMap<
  StudioEditingSession,
  StudioEditingSessionImplementation
>();

export function createStudioEditingSession(
  seed: StudioSessionSeed,
  dependencies?: StudioSessionDependencies,
  options?: StudioSessionOptions,
): StudioEditingSession {
  const implementation = new StudioEditingSessionImplementation(
    seed,
    dependencies,
    options,
  );
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
