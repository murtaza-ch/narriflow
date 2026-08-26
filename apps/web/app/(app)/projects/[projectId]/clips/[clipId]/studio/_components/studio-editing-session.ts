import { compositionAssetRef } from "@narriflow/composition-plan";
import {
  clipAutoLayoutMatchesInputs,
  editedToSource,
  sourceToEdited,
  type ClipAutoLayoutAnalysis,
  type EditedTimeMap,
  type EditorAction,
  type EditorDocument,
  type TranscriptUtterance,
} from "@narriflow/validators";
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
  mergeEditorDocuments,
  type StoredEditorDraft,
} from "./local-editor-draft";
import { buildStudioCutPlan } from "./edited-timeline";
import { stepRipple } from "./ripple-playback";

type Listener = () => void;
const PREVIEW_POLL_INTERVAL_MS = 8_000;
const PREVIEW_POLL_MAX_ATTEMPTS = 45;
const AUTO_LAYOUT_POLL_INITIAL_MS = 2_000;
const AUTO_LAYOUT_POLL_MAX_MS = 30_000;
const AUTO_LAYOUT_POLL_DEADLINE_MS = 6 * 60_000;
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

/** Immutable projection rendered by React and observed by behavior tests. */
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
  cloud: {
    state:
      | "current"
      | "pending"
      | "saving"
      | "offline"
      | "retrying"
      | "rejected"
      | "authentication-lost"
      | "missing"
      | "revision-conflict";
    revision: number;
    dirty: boolean;
    rejectionCode: string | null;
  };
  preview: StudioPreviewSnapshot;
  playback: StudioPlaybackSnapshot;
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
  | { type: "history.redo" }
  | { type: "preview.set-source-fallback"; enabled: boolean }
  | { type: "playback.seek"; editedTimeSec: number }
  | { type: "playback.play" }
  | { type: "playback.pause" }
  | { type: "playback.toggle" }
  | { type: "playback.set-rate"; rate: number }
  | { type: "playback.reload" };

export type IntentReceipt =
  | { accepted: true }
  | { accepted: false; reason: "starting" | "read-only" | "conflict" | "closed" };

/** Typed asynchronous operation surface agreed by the Studio session ADR. */
export type StudioSessionOperation =
  | { type: "start" }
  | { type: "resume" }
  | {
      type: "trim";
      startSec: number;
      endSec: number;
      transcriptSlice: TranscriptUtterance[];
      segments: TimelineSegment[];
    }
  | { type: "checkpoint-cloud" }
  | { type: "prepare-cloud-revision" }
  | { type: "take-over" }
  | { type: "resolve-conflict"; choice: "device" | "cloud" }
  | { type: "reset-to-original" }
  | { type: "close"; reason: "unmount" | "navigation" | "pagehide" };

export type StudioOperationResult =
  | { kind: "unavailable"; reason: "not-implemented" | "invalid-state" }
  | { kind: "started" }
  | { kind: "trimmed" }
  | { kind: "closed" }
  | { kind: "conflict-resolved"; choice: "device" | "cloud" }
  | {
      kind: "conflict-resolved-degraded";
      choice: "cloud";
      reason: "device-draft-unavailable";
    }
  | {
      kind: "conflict-resolution-blocked";
      choice: "cloud";
      reason: "ownership-lost";
    }
  | { kind: "cloud-current"; revision: number }
  | {
      kind: "cloud-refreshed";
      revision: number;
      convergence: "current" | "merged" | "conflict";
    }
  | { kind: "cloud-prepared"; revision: number }
  | {
      kind: "cloud-blocked";
      reason:
        | "read-only"
        | "semantic-rejection"
        | "authentication-lost"
        | "missing"
        | "revision-conflict"
        | "unresolved-conflict"
        | "transient"
        | "closed";
      code?: string;
    }
  | {
      kind: "reset-complete";
      revision: number;
      document: DeepReadonly<EditorDocument>;
      reloadRequired: true;
    }
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
  preview?: StudioPreviewSeed;
}

export type StudioDocumentWindowFingerprint = string;

export interface StudioProxySeed {
  url: string;
  startSec: number;
  durationSec: number | null;
  waveformPeaksUrl: string | null;
}

export interface StudioProxyStatus {
  previewUrl: string | null;
  previewStartSec: number;
  previewDurationSec: number | null;
  waveformPeaksUrl: string | null;
}

export interface StudioPreviewSeed {
  sourceUrl: string | null;
  sourcePurged: boolean;
  proxy: StudioProxySeed | null;
  automaticLayout: ClipAutoLayoutAnalysis | null;
}

export interface StudioProxyDescriptor extends StudioProxySeed {
  windowFingerprint: StudioDocumentWindowFingerprint;
}

export interface StudioPreviewSnapshot {
  windowFingerprint: StudioDocumentWindowFingerprint;
  proxy: DeepReadonly<StudioProxyDescriptor> | null;
  waveformPeaksUrl: string | null;
  automaticLayout: DeepReadonly<ClipAutoLayoutAnalysis> | null;
  automaticLayoutStatus: "available" | "pending" | "failed";
  activeAsset:
    | { kind: "proxy"; url: string; offsetSec: number }
    | { kind: "source"; url: string; offsetSec: 0 }
    | { kind: "unavailable"; url: null; offsetSec: 0 };
}

export interface StudioMediaBinding {
  sessionGeneration: number;
  mediaGeneration: number;
}

export interface StudioPlaybackSnapshot {
  editedTimeSec: number;
  durationSec: number;
  state: "paused" | "playing";
  rate: number;
  mediaBinding: StudioMediaBinding;
}

export type StudioMediaCommand =
  | {
      type: "load";
      binding: StudioMediaBinding;
      url: string;
      mediaTimeSec: number;
      rate: number;
      playing: boolean;
      muted: boolean;
      volume: number;
    }
  | { type: "unload"; binding: StudioMediaBinding }
  | { type: "seek"; binding: StudioMediaBinding; mediaTimeSec: number }
  | { type: "play"; binding: StudioMediaBinding }
  | { type: "pause"; binding: StudioMediaBinding }
  | { type: "set-rate"; binding: StudioMediaBinding; rate: number }
  | {
      type: "set-audio";
      binding: StudioMediaBinding;
      muted: boolean;
      volume: number;
    };

export type StudioMediaEvent =
  | { type: "time"; binding: StudioMediaBinding; mediaTimeSec: number }
  | { type: "played"; binding: StudioMediaBinding }
  | { type: "paused"; binding: StudioMediaBinding }
  | { type: "ended"; binding: StudioMediaBinding }
  | { type: "seeked"; binding: StudioMediaBinding; mediaTimeSec: number };

export interface StudioMediaAdapter {
  subscribe(listener: (event: StudioMediaEvent) => void): () => void;
  command(command: StudioMediaCommand): void;
}

export interface StudioSessionOptions {
  deferStart?: boolean;
}

export type StudioDraftRecord = StoredEditorDraft;

export interface StudioCoordinationParticipant {
  onTakeoverRequested(): Promise<"checkpointed" | "unavailable">;
  onOwnershipLost(): void;
}

export type StudioCloudSaveOutcome =
  | { kind: "saved"; revision: number; document: EditorDocument }
  | {
      kind: "transient";
      reason:
        | "network"
        | "offline"
        | "timeout"
        | "too-early"
        | "rate-limited"
        | "server";
    }
  | { kind: "authentication-lost" }
  | { kind: "missing" }
  | { kind: "rejected"; code: string }
  | { kind: "revision-conflict"; currentRevision?: number };

export type StudioCloudResetOutcome =
  | { kind: "reset"; revision: number; document: EditorDocument }
  | Exclude<StudioCloudSaveOutcome, { kind: "saved" }>;

type StudioCloudTerminalOutcome = Exclude<
  StudioCloudSaveOutcome,
  { kind: "saved" | "transient" }
>;

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
    save?(input: {
      baseRevision: number;
      document: EditorDocument;
    }): Promise<StudioCloudSaveOutcome>;
    reset?(input: { baseRevision: number }): Promise<StudioCloudResetOutcome>;
    keepalive?(input: { baseRevision: number; document: EditorDocument }): void;
  };
  preview?: {
    fetchProxyStatus?(): Promise<StudioProxyStatus>;
    fetchAutomaticLayout?(): Promise<ClipAutoLayoutAnalysis | null>;
  };
  media?: StudioMediaAdapter;
  runtime: {
    now(): number;
    createId(): string;
    setTimeout(callback: () => void, delayMs: number): number;
    clearTimeout(id: number): void;
    random?(): number;
    isOnline?(): boolean;
    subscribeOnline?(listener: (online: boolean) => void): () => void;
  };
}

interface SessionProjection {
  status: StudioSessionSnapshot["status"];
  recovery: StudioSessionSnapshot["recovery"];
  durability: StudioSessionSnapshot["durability"];
  ownership: StudioSessionSnapshot["ownership"];
  cloud: StudioSessionSnapshot["cloud"];
}

type DeviceDraftCheckpointOutcome = "checkpointed" | "stale" | "unavailable";
type DraftFenceOutcome = "fenced" | "stale" | "unavailable";
type DraftRemovalOutcome = "removed" | "stale" | "unavailable";
type DraftLoadResult =
  | { kind: "loaded"; draft: StudioDraftRecord | null }
  | { kind: "failed"; draft: null; error: string };

function snapshotFor(
  unified: UnifiedEditorHistory,
  projection: SessionProjection,
  preview: StudioPreviewSnapshot,
  playback: StudioPlaybackSnapshot,
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
    preview,
    playback,
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

export function studioPreviewSnapshotsEqual(
  left: StudioPreviewSnapshot,
  right: StudioPreviewSnapshot,
): boolean {
  return (
    left.windowFingerprint === right.windowFingerprint &&
    left.proxy === right.proxy &&
    left.waveformPeaksUrl === right.waveformPeaksUrl &&
    left.automaticLayout === right.automaticLayout &&
    left.automaticLayoutStatus === right.automaticLayoutStatus &&
    left.activeAsset.kind === right.activeAsset.kind &&
    left.activeAsset.url === right.activeAsset.url &&
    left.activeAsset.offsetSec === right.activeAsset.offsetSec
  );
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
    left.ownership.generation === right.ownership.generation &&
    left.cloud.state === right.cloud.state &&
    left.cloud.revision === right.cloud.revision &&
    left.cloud.dirty === right.cloud.dirty &&
    left.cloud.rejectionCode === right.cloud.rejectionCode &&
    studioPreviewSnapshotsEqual(left.preview, right.preview) &&
    left.playback.editedTimeSec === right.playback.editedTimeSec &&
    left.playback.durationSec === right.playback.durationSec &&
    left.playback.state === right.playback.state &&
    left.playback.rate === right.playback.rate &&
    left.playback.mediaBinding.sessionGeneration ===
      right.playback.mediaBinding.sessionGeneration &&
    left.playback.mediaBinding.mediaGeneration ===
      right.playback.mediaBinding.mediaGeneration
  );
}

function documentWindowFingerprint(
  document: Pick<EditorDocument, "clipStartSec" | "clipEndSec">,
): StudioDocumentWindowFingerprint {
  return `${document.clipStartSec.toFixed(3)}:${document.clipEndSec.toFixed(3)}`;
}

function automaticLayoutInputFingerprint(
  document: Pick<
    EditorDocument,
    "clipStartSec" | "clipEndSec" | "deletedRanges"
  >,
): string {
  return JSON.stringify({
    window: documentWindowFingerprint(document),
    deletedRanges: document.deletedRanges.map((range) => [
      range.startSec.toFixed(3),
      range.endSec.toFixed(3),
    ]),
  });
}

function playbackInputFingerprint(
  document: Pick<
    EditorDocument,
    "clipStartSec" | "clipEndSec" | "deletedRanges"
  >,
): string {
  return JSON.stringify({
    window: documentWindowFingerprint(document),
    deletedRanges: document.deletedRanges,
  });
}

interface CloudAttempt {
  baseRevision: number;
  document: EditorDocument;
  documentVersion: number;
  retryCount: number;
}

interface CloudWaiter {
  kind: "checkpoint" | "prepare";
  resolve(result: StudioOperationResult): void;
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
  private documentVersion = 0;
  private cloudAttempt: CloudAttempt | null = null;
  private cloudSaveRunning = false;
  private cloudWakeRequested = false;
  private cloudAutosaveTimer: number | null = null;
  private cloudRetryTimer: number | null = null;
  private cloudRefreshRetryTimer: number | null = null;
  private cloudRefreshRetryWake: (() => void) | null = null;
  private resetRetryTimer: number | null = null;
  private resetRetryWake: (() => void) | null = null;
  private cloudDirtySince: number | null = null;
  private readonly cloudWaiters: CloudWaiter[] = [];
  private unsubscribeOnline: (() => void) | null = null;
  private resetInProgress = false;
  private cloudRefreshGeneration = 0;
  private readonly sourceUrl: string | null;
  private readonly sourcePurged: boolean;
  private readonly automaticLayoutSourceIdentity: string | null;
  private retainedProxy: StudioProxyDescriptor | null;
  private retainedAutomaticLayout: ClipAutoLayoutAnalysis | null;
  private replacementSourceFallback = false;
  private manualSourceFallback = false;
  private proxyPollTimer: number | null = null;
  private proxyPollTarget: StudioDocumentWindowFingerprint | null = null;
  private proxyPollAttempts = 0;
  private proxyPollGeneration = 0;
  private proxyPollRunning = false;
  private automaticLayoutPollTimer: number | null = null;
  private automaticLayoutDeadlineTimer: number | null = null;
  private automaticLayoutPollTarget: string | null = null;
  private automaticLayoutPollDeadline = 0;
  private automaticLayoutPollDelayMs = AUTO_LAYOUT_POLL_INITIAL_MS;
  private automaticLayoutPollGeneration = 0;
  private automaticLayoutPollRunning = false;
  private automaticLayoutPollFailed = false;
  private playbackMap: EditedTimeMap;
  private playbackDocument: EditorDocument;
  private playbackSourceTimeSec: number;
  private playback: StudioPlaybackSnapshot;
  private mediaGeneration = 0;
  private mediaAssetKey: string | null = null;
  private mediaOffsetSec = 0;
  private mediaAudioFingerprint: string | null = null;
  private unsubscribeMedia: (() => void) | null = null;
  private pendingMediaSeekSourceSec: number | null = null;

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
    this.sourceUrl = seed.preview?.sourceUrl ?? null;
    this.sourcePurged = seed.preview?.sourcePurged ?? false;
    this.automaticLayoutSourceIdentity = seed.projectId
      ? compositionAssetRef("source", seed.projectId)
      : null;
    this.retainedProxy = seed.preview?.proxy
      ? deepFreeze({
          ...structuredClone(seed.preview.proxy),
          windowFingerprint: documentWindowFingerprint(seed.document),
        })
      : null;
    this.retainedAutomaticLayout = seed.preview?.automaticLayout
      ? deepFreeze(structuredClone(seed.preview.automaticLayout))
      : null;
    this.playbackMap = this.playbackMapFor(seed.document);
    this.playbackDocument = this.unified.doc.present;
    this.playbackSourceTimeSec = editedToSource(this.playbackMap, 0);
    this.playback = deepFreeze({
      editedTimeSec: 0,
      durationSec: this.playbackMap.editedDurationSec,
      state: "paused",
      rate: 1,
      mediaBinding: {
        sessionGeneration: this.sessionGeneration,
        mediaGeneration: this.mediaGeneration,
      },
    });
    this.projection = dependencies
      ? {
          status: "starting",
          recovery: { kind: "none", conflictPaths: [] },
          durability: { device: "pending", protectsNavigation: true },
          ownership: { kind: "pending", generation: null },
          cloud: {
            state: "current",
            revision: this.cloudRevision,
            dirty: false,
            rejectionCode: null,
          },
        }
      : {
          status: "ready",
          recovery: { kind: "none", conflictPaths: [] },
          durability: { device: "durable", protectsNavigation: false },
          ownership: { kind: "writer", generation: 0 },
          cloud: {
            state: "current",
            revision: this.cloudRevision,
            dirty: false,
            rejectionCode: null,
          },
        };
    this.bindMediaToActiveAsset(this.previewSnapshot());
    this.snapshot = snapshotFor(
      this.unified,
      this.projection,
      this.previewSnapshot(),
      this.playback,
    );
    this.started = !dependencies || !options.deferStart;
    if (dependencies && this.started) void this.initialize();
  }

  getSnapshot = (): StudioSessionSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch = (intent: StudioSessionIntent): IntentReceipt => {
    if (intent.type.startsWith("playback.")) {
      if (this.projection.status === "closed") {
        return { accepted: false, reason: "closed" };
      }
      switch (intent.type) {
        case "playback.seek":
          this.seekPlayback(intent.editedTimeSec);
          break;
        case "playback.play":
          this.play();
          break;
        case "playback.pause":
          this.pause();
          break;
        case "playback.toggle":
          if (this.playback.state === "playing") this.pause();
          else this.play();
          break;
        case "playback.set-rate": {
          const rate = Number.isFinite(intent.rate)
            ? Math.max(0.5, Math.min(2, intent.rate))
            : 1;
          this.replacePlayback({ rate });
          if (this.mediaAssetKey) {
            this.dependencies?.media?.command({
              type: "set-rate",
              binding: this.playback.mediaBinding,
              rate,
            });
          }
          break;
        }
        case "playback.reload":
          this.mediaAssetKey = null;
          break;
      }
      this.publish();
      return { accepted: true };
    }
    if (intent.type === "preview.set-source-fallback") {
      if (this.projection.status === "closed") {
        return { accepted: false, reason: "closed" };
      }
      this.manualSourceFallback = intent.enabled;
      this.publish();
      return { accepted: true };
    }
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
      this.reconcilePlaybackAfterDocumentChange();
      this.scheduleDeviceDraftWrite();
      this.markCloudDirty();
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
        return { kind: "closed" };
      }
      this.releaseMedia();
      this.sessionGeneration += 1;
      this.clearCloudTimers();
      this.clearDerivedPolling();
      this.unsubscribeOnline?.();
      this.unsubscribeOnline = null;
      if (
        !this.cloudSaveRunning &&
        this.projection.cloud.dirty &&
        this.dependencies?.cloud.keepalive &&
        (this.projection.ownership.kind === "writer" ||
          this.projection.ownership.kind === "degraded")
      ) {
        this.dependencies.cloud.keepalive({
          baseRevision: this.cloudRevision,
          document: ownDocument(this.unified.doc.present),
        });
      }
      this.projection = { ...this.projection, status: "closed" };
      this.publish();
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
      this.settleCloudWaiters();
      return { kind: "closed" };
    }
    if (operation.type === "take-over") {
      return this.takeOver();
    }
    if (operation.type === "trim") {
      if (!this.snapshot.capabilities.mutate) {
        return { kind: "unavailable", reason: "invalid-state" };
      }
      this.applyDocumentAndResegment({
        action: {
          type: "trimClip",
          startSec: operation.startSec,
          endSec: operation.endSec,
          transcriptSlice: structuredClone(operation.transcriptSlice),
        },
        segments: operation.segments,
      });
      return { kind: "trimmed" };
    }
    if (operation.type === "resume") {
      if (!this.dependencies || this.projection.status !== "ready") {
        return { kind: "unavailable", reason: "invalid-state" };
      }
      const refreshed = await this.refreshCloudHeadAndConverge({ kind: "resume" });
      if (!refreshed) {
        return this.getSnapshot().status === "closed"
          ? { kind: "cloud-blocked", reason: "closed" }
          : { kind: "cloud-blocked", reason: "transient" };
      }
      return { kind: "cloud-refreshed", ...refreshed };
    }
    if (operation.type === "checkpoint-cloud") {
      if (this.resetInProgress && !this.projection.cloud.dirty) {
        this.resetRetryWake?.();
        return { kind: "cloud-current", revision: this.cloudRevision };
      }
      return this.waitForCloudCurrent("checkpoint");
    }
    if (operation.type === "prepare-cloud-revision") {
      return this.waitForCloudCurrent("prepare");
    }
    if (operation.type === "reset-to-original") {
      return this.resetToOriginal();
    }
    if (operation.type !== "resolve-conflict") {
      return { kind: "unavailable", reason: "not-implemented" };
    }
    if (!this.pendingConflict || this.projection.status !== "conflict") {
      return { kind: "unavailable", reason: "invalid-state" };
    }
    const conflict = this.pendingConflict;
    let cloudResolutionDegraded = false;
    if (operation.choice === "cloud") {
      const removal = await this.removeObsoleteDeviceDraft();
      if (removal === "stale") {
        this.publish();
        return {
          kind: "conflict-resolution-blocked",
          choice: "cloud",
          reason: "ownership-lost",
        };
      }
      cloudResolutionDegraded = removal === "unavailable";
    }
    const document =
      operation.choice === "device"
        ? conflict.deviceDocument
        : conflict.cloudDocument;
    this.unified = createUnifiedEditorHistory(
      ownDocument(document),
      ownSegments(this.unified.segments),
    );
    this.documentVersion += 1;
    this.cloudAttempt = null;
    this.cloudDirtySince = null;
    this.clearCloudTimers();
    this.pendingConflict = null;
    this.projection = {
      ...this.projection,
      status: "ready",
      recovery: {
        kind: operation.choice === "device" ? "recovered" : "none",
        conflictPaths: [],
      },
      cloud:
        operation.choice === "device"
          ? {
              state: this.dependencies?.runtime.isOnline?.() === false
                ? "offline"
                : "pending",
              revision: this.cloudRevision,
              dirty: true,
              rejectionCode: null,
            }
          : {
              state: "current",
              revision: this.cloudRevision,
              dirty: false,
              rejectionCode: null,
            },
    };
    if (operation.choice === "device") {
      this.cloudDirtySince = this.dependencies?.runtime.now() ?? Date.now();
      this.scheduleDeviceDraftWrite();
      this.scheduleCloudAutosave();
    }
    this.publish();
    this.settleCloudWaiters();
    if (cloudResolutionDegraded) {
      return {
        kind: "conflict-resolved-degraded",
        choice: "cloud",
        reason: "device-draft-unavailable",
      };
    }
    return { kind: "conflict-resolved", choice: operation.choice };
  };

  private applyDocumentAndResegment(input: {
    action: EditorAction;
    segments: TimelineSegment[];
  }): void {
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
      this.reconcilePlaybackAfterDocumentChange();
      this.scheduleDeviceDraftWrite();
      this.markCloudDirty();
    }
    this.publish();
  }

  private markCloudDirty(): void {
    this.documentVersion += 1;
    if (this.documentsEqual(this.unified.doc.present, this.cloudDocument)) {
      this.cloudAttempt = null;
      this.clearCloudTimers();
      this.cloudDirtySince = null;
      this.projection = {
        ...this.projection,
        cloud: {
          state: "current",
          revision: this.cloudRevision,
          dirty: false,
          rejectionCode: null,
        },
      };
      this.settleCloudWaiters();
      return;
    }
    if (this.cloudDirtySince === null) {
      this.cloudDirtySince = this.dependencies?.runtime.now() ?? Date.now();
    }
    const online = this.dependencies?.runtime.isOnline?.() ?? true;
    this.projection = {
      ...this.projection,
      cloud: {
        state: online ? "pending" : "offline",
        revision: this.cloudRevision,
        dirty: true,
        rejectionCode: null,
      },
    };
    if (!this.cloudAttempt) {
      if (this.cloudAutosaveTimer !== null && this.dependencies) {
        this.dependencies.runtime.clearTimeout(this.cloudAutosaveTimer);
        this.cloudAutosaveTimer = null;
      }
      this.scheduleCloudAutosave();
    }
  }

  private scheduleCloudAutosave(): void {
    const dependencies = this.dependencies;
    if (
      !dependencies?.cloud.save ||
      this.cloudSaveRunning ||
      this.cloudAttempt ||
      this.cloudAutosaveTimer !== null ||
      this.projection.status !== "ready" ||
      this.resetInProgress ||
      (this.projection.ownership.kind !== "writer" &&
        this.projection.ownership.kind !== "degraded")
    ) {
      return;
    }
    const dirtyFor = Math.max(
      0,
      dependencies.runtime.now() - (this.cloudDirtySince ?? dependencies.runtime.now()),
    );
    const delayMs = Math.min(1_500, Math.max(0, 5_000 - dirtyFor));
    this.cloudAutosaveTimer = dependencies.runtime.setTimeout(() => {
      this.cloudAutosaveTimer = null;
      void this.startCloudCheckpoint();
    }, delayMs);
  }

  private waitForCloudCurrent(
    kind: CloudWaiter["kind"],
  ): Promise<StudioOperationResult> {
    if (this.projection.status === "starting" && !this.resetInProgress) {
      this.cloudRefreshRetryWake?.();
      return new Promise((resolve) => {
        const unsubscribe = this.subscribe(() => {
          if (this.projection.status === "starting") return;
          unsubscribe();
          void this.waitForCloudCurrent(kind).then(resolve);
        });
      });
    }
    const terminal = this.cloudTerminalResult();
    if (terminal) return Promise.resolve(terminal);
    if (!this.projection.cloud.dirty && this.projection.cloud.state === "current") {
      return Promise.resolve(
        kind === "prepare"
          ? { kind: "cloud-prepared", revision: this.cloudRevision }
          : { kind: "cloud-current", revision: this.cloudRevision },
      );
    }
    return new Promise((resolve) => {
      this.cloudWaiters.push({ kind, resolve });
      this.wakeCloudCheckpoint();
    });
  }

  private cloudTerminalResult(): StudioOperationResult | null {
    if (this.projection.status === "closed") {
      return { kind: "cloud-blocked", reason: "closed" };
    }
    if (this.projection.status === "conflict") {
      return { kind: "cloud-blocked", reason: "unresolved-conflict" };
    }
    if (
      this.projection.ownership.kind !== "writer" &&
      this.projection.ownership.kind !== "degraded"
    ) {
      return this.projection.cloud.dirty
        ? { kind: "cloud-blocked", reason: "read-only" }
        : null;
    }
    switch (this.projection.cloud.state) {
      case "rejected":
        return {
          kind: "cloud-blocked",
          reason: "semantic-rejection",
          ...(this.projection.cloud.rejectionCode
            ? { code: this.projection.cloud.rejectionCode }
            : {}),
        };
      case "authentication-lost":
        return { kind: "cloud-blocked", reason: "authentication-lost" };
      case "missing":
        return { kind: "cloud-blocked", reason: "missing" };
      case "revision-conflict":
        return { kind: "cloud-blocked", reason: "revision-conflict" };
      default:
        return null;
    }
  }

  private settleCloudWaiters(): void {
    const terminal = this.cloudTerminalResult();
    const current =
      !this.projection.cloud.dirty && this.projection.cloud.state === "current";
    if (!terminal && !current) return;
    const waiters = this.cloudWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve(
        terminal ??
          (waiter.kind === "prepare"
            ? { kind: "cloud-prepared", revision: this.cloudRevision }
            : { kind: "cloud-current", revision: this.cloudRevision }),
      );
    }
  }

  private wakeCloudCheckpoint(): void {
    const dependencies = this.dependencies;
    if (!dependencies?.cloud.save) return;
    if (this.cloudAutosaveTimer !== null) {
      dependencies.runtime.clearTimeout(this.cloudAutosaveTimer);
      this.cloudAutosaveTimer = null;
    }
    if (this.cloudRetryTimer !== null) {
      dependencies.runtime.clearTimeout(this.cloudRetryTimer);
      this.cloudRetryTimer = null;
    }
    if (this.cloudSaveRunning) {
      this.cloudWakeRequested = true;
      return;
    }
    void this.startCloudCheckpoint();
  }

  private async startCloudCheckpoint(): Promise<void> {
    const dependencies = this.dependencies;
    if (
      !dependencies?.cloud.save ||
      this.cloudSaveRunning ||
      !this.projection.cloud.dirty ||
      (this.projection.status !== "ready" && !this.resetInProgress) ||
      (this.projection.ownership.kind !== "writer" &&
        this.projection.ownership.kind !== "degraded")
    ) {
      return;
    }
    const expectedSessionGeneration = this.sessionGeneration;
    const attempt =
      this.cloudAttempt ??
      ({
        baseRevision: this.cloudRevision,
        document: ownDocument(this.unified.doc.present),
        documentVersion: this.documentVersion,
        retryCount: 0,
      } satisfies CloudAttempt);
    this.cloudAttempt = attempt;
    this.cloudSaveRunning = true;
    this.projection = {
      ...this.projection,
      cloud: { ...this.projection.cloud, state: "saving", rejectionCode: null },
    };
    this.publish();

    if (this.draftWriteTimer !== null) {
      dependencies.runtime.clearTimeout(this.draftWriteTimer);
      this.draftWriteTimer = null;
    }
    await this.queueDeviceDraftCheckpoint();
    if (
      this.sessionGeneration !== expectedSessionGeneration ||
      this.projection.status === "closed"
    ) {
      this.cloudSaveRunning = false;
      return;
    }

    let outcome: StudioCloudSaveOutcome;
    if (!(dependencies.runtime.isOnline?.() ?? true)) {
      outcome = { kind: "transient", reason: "offline" };
    } else {
      try {
        outcome = await dependencies.cloud.save({
          baseRevision: attempt.baseRevision,
          document: ownDocument(attempt.document),
        });
      } catch {
        outcome = { kind: "transient", reason: "network" };
      }
    }
    if (this.sessionGeneration !== expectedSessionGeneration) {
      this.cloudSaveRunning = false;
      return;
    }
    await this.handleCloudOutcome(attempt, outcome);
    this.cloudSaveRunning = false;
    if (this.cloudWakeRequested) {
      this.cloudWakeRequested = false;
      void this.startCloudCheckpoint();
      return;
    }
    if (
      this.projection.cloud.dirty &&
      this.projection.cloud.state === "pending" &&
      !this.cloudAttempt
    ) {
      void this.startCloudCheckpoint();
    }
  }

  private async handleCloudOutcome(
    attempt: CloudAttempt,
    outcome: StudioCloudSaveOutcome,
  ): Promise<void> {
    if (outcome.kind === "saved") {
      this.cloudAttempt = null;
      this.cloudRevision = outcome.revision;
      this.retireDerivedAssetsForAcknowledgedChange(
        this.cloudDocument,
        outcome.document,
      );
      this.cloudDocument = ownDocument(outcome.document);
      const isCurrent = this.documentVersion === attempt.documentVersion;
      if (isCurrent) {
        this.unified = {
          ...this.unified,
          doc: { ...this.unified.doc, present: ownDocument(outcome.document) },
        };
        this.cloudDirtySince = null;
        this.projection = {
          ...this.projection,
          cloud: {
            state: "current",
            revision: this.cloudRevision,
            dirty: false,
            rejectionCode: null,
          },
        };
        if ((await this.removeObsoleteDeviceDraft()) === "stale") return;
      } else {
        this.projection = {
          ...this.projection,
          cloud: {
            state: "pending",
            revision: this.cloudRevision,
            dirty: true,
            rejectionCode: null,
          },
        };
      }
      this.publish();
      this.settleCloudWaiters();
      return;
    }

    if (outcome.kind === "transient") {
      attempt.retryCount += 1;
      this.projection = {
        ...this.projection,
        cloud: {
          ...this.projection.cloud,
          state: outcome.reason === "offline" ? "offline" : "retrying",
          dirty: true,
          rejectionCode: null,
        },
      };
      this.publish();
      this.scheduleCloudRetry(attempt.retryCount - 1);
      return;
    }

    if (outcome.kind === "revision-conflict") {
      this.cloudAttempt = null;
      await this.refreshCloudHeadAndConverge({
        kind: "revision-conflict",
        minimumRevision:
          outcome.currentRevision === undefined
            ? this.cloudRevision + 1
            : Math.max(this.cloudRevision + 1, outcome.currentRevision),
      });
      return;
    }

    this.cloudAttempt = null;
    const newerDocumentExists = this.documentVersion !== attempt.documentVersion;
    if (outcome.kind === "rejected" && newerDocumentExists) {
      this.projection = {
        ...this.projection,
        cloud: {
          state: "pending",
          revision: this.cloudRevision,
          dirty: true,
          rejectionCode: null,
        },
      };
      this.publish();
      return;
    }
    this.projectTerminalCloudOutcome(outcome);
    this.publish();
    this.settleCloudWaiters();
  }

  private async refreshCloudHeadAndConverge(
    request:
      | { kind: "resume" }
      | { kind: "revision-conflict"; minimumRevision: number },
  ): Promise<{
    revision: number;
    convergence: "current" | "merged" | "conflict";
  } | null> {
    const dependencies = this.dependencies;
    if (!dependencies) return null;
    const expectedSessionGeneration = this.sessionGeneration;
    const expectedDocumentVersion = this.documentVersion;
    const refreshGeneration = ++this.cloudRefreshGeneration;
    const projectionBeforeRefresh = this.projection;
    const baselineRevision = this.cloudRevision;
    const refreshPolicy =
      request.kind === "resume"
        ? {
            minimumRevision: baselineRevision,
            enteringCloudState: this.projection.cloud.state,
            autosaveMergedDocument: true,
          }
        : {
            minimumRevision: request.minimumRevision,
            enteringCloudState: "revision-conflict" as const,
            autosaveMergedDocument: false,
          };
    this.projection = {
      ...this.projection,
      status: "starting",
      cloud: {
        ...this.projection.cloud,
        state: refreshPolicy.enteringCloudState,
        revision: this.cloudRevision,
        rejectionCode: null,
      },
    };
    this.publish();

    const refreshIsCurrent = () =>
      this.sessionGeneration === expectedSessionGeneration &&
      this.documentVersion === expectedDocumentVersion &&
      this.cloudRefreshGeneration === refreshGeneration;
    let head: { revision: number; document: EditorDocument } | null = null;
    let retryAttempt = 0;
    while (refreshIsCurrent()) {
      let error: unknown;
      if (!(dependencies.runtime.isOnline?.() ?? true)) {
        error = new Error("offline");
      } else {
        try {
          const candidate = await dependencies.cloud.loadHead();
          if (!refreshIsCurrent()) return null;
          const currentBaseline =
            candidate.revision === baselineRevision &&
            this.documentsEqual(candidate.document, this.cloudDocument);
          if (
            candidate.revision >= refreshPolicy.minimumRevision &&
            (candidate.revision > baselineRevision || currentBaseline)
          ) {
            head = candidate;
            break;
          }
          error = new Error(`stale cloud revision ${candidate.revision}`);
        } catch (loadError) {
          error = loadError;
        }
      }
      if (!refreshIsCurrent()) return null;
      this.diagnose("studio_cloud_refresh_retrying", "transient", error);
      this.projection = {
        ...this.projection,
        status: "starting",
        cloud: {
          ...this.projection.cloud,
          state: (dependencies.runtime.isOnline?.() ?? true)
            ? "retrying"
            : "offline",
          rejectionCode: null,
        },
      };
      this.publish();
      await this.waitForCloudRefreshRetry(retryAttempt);
      retryAttempt += 1;
    }
    if (!head || !refreshIsCurrent()) return null;
    if (
      head.revision === baselineRevision &&
      this.documentsEqual(head.document, this.cloudDocument)
    ) {
      this.projection = { ...projectionBeforeRefresh, status: "ready" };
      this.publish();
      return {
        revision: this.cloudRevision,
        convergence: "current",
      };
    }

    const deviceDocument = ownDocument(this.unified.doc.present);
    const merged = mergeEditorDocuments(
      this.cloudDocument,
      deviceDocument,
      head.document,
    );
    this.cloudRevision = head.revision;
    this.retireDerivedAssetsForAcknowledgedChange(
      this.cloudDocument,
      head.document,
    );
    this.cloudDocument = ownDocument(head.document);
    this.cloudDirtySince = null;
    this.clearCloudTimers();

    if (merged.conflicts.length > 0) {
      this.pendingConflict = {
        deviceDocument,
        cloudDocument: this.cloudDocument,
      };
      this.projection = {
        ...this.projection,
        status: "conflict",
        recovery: { kind: "conflict", conflictPaths: merged.conflicts },
        cloud: {
          state: "revision-conflict",
          revision: this.cloudRevision,
          dirty: true,
          rejectionCode: null,
        },
      };
      this.publish();
      this.settleCloudWaiters();
      return { revision: this.cloudRevision, convergence: "conflict" };
    }

    this.pendingConflict = null;
    this.unified = createUnifiedEditorHistory(
      ownDocument(merged.document),
      ownSegments(this.unified.segments),
    );
    this.documentVersion += 1;
    const dirty = !this.documentsEqual(merged.document, this.cloudDocument);
    this.projection = {
      ...this.projection,
      status: "ready",
      recovery: {
        kind: dirty ? "merged" : "none",
        conflictPaths: [],
      },
      cloud: {
        state: dirty ? "pending" : "current",
        revision: this.cloudRevision,
        dirty,
        rejectionCode: null,
      },
    };
    if (dirty) {
      this.cloudDirtySince = dependencies.runtime.now();
      this.scheduleDeviceDraftWrite();
      if (refreshPolicy.autosaveMergedDocument) this.scheduleCloudAutosave();
    }
    this.publish();
    this.settleCloudWaiters();
    return {
      revision: this.cloudRevision,
      convergence: dirty ? "merged" : "current",
    };
  }

  private scheduleCloudRetry(attempt: number): void {
    const dependencies = this.dependencies;
    if (!dependencies || this.cloudRetryTimer !== null) return;
    const delayMs = this.retryDelayMs(attempt);
    this.cloudRetryTimer = dependencies.runtime.setTimeout(() => {
      this.cloudRetryTimer = null;
      void this.startCloudCheckpoint();
    }, delayMs);
  }

  private clearCloudTimers(): void {
    const dependencies = this.dependencies;
    if (!dependencies) return;
    this.cloudWakeRequested = false;
    if (this.cloudAutosaveTimer !== null) {
      dependencies.runtime.clearTimeout(this.cloudAutosaveTimer);
      this.cloudAutosaveTimer = null;
    }
    if (this.cloudRetryTimer !== null) {
      dependencies.runtime.clearTimeout(this.cloudRetryTimer);
      this.cloudRetryTimer = null;
    }
    this.cloudRefreshRetryWake?.();
    this.resetRetryWake?.();
  }

  private documentsEqual(left: EditorDocument, right: EditorDocument): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private projectTerminalCloudOutcome(
    outcome: StudioCloudTerminalOutcome,
    dirty = true,
  ): void {
    this.projection = {
      ...this.projection,
      cloud: {
        state: outcome.kind,
        revision: this.cloudRevision,
        dirty,
        rejectionCode: outcome.kind === "rejected" ? outcome.code : null,
      },
    };
  }

  private retryDelayMs(attempt: number): number {
    const dependencies = this.dependencies;
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(5, Math.max(0, attempt)));
    const jitter = 0.75 + (dependencies?.runtime.random?.() ?? Math.random()) * 0.5;
    return Math.min(30_000, Math.round(base * jitter));
  }

  private waitForCloudRefreshRetry(attempt: number): Promise<void> {
    const dependencies = this.dependencies;
    if (!dependencies) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        if (this.cloudRefreshRetryTimer !== null) {
          dependencies.runtime.clearTimeout(this.cloudRefreshRetryTimer);
          this.cloudRefreshRetryTimer = null;
        }
        this.cloudRefreshRetryWake = null;
        resolve();
      };
      this.cloudRefreshRetryWake = wake;
      this.cloudRefreshRetryTimer = dependencies.runtime.setTimeout(
        wake,
        this.retryDelayMs(attempt),
      );
    });
  }

  private waitForResetRetry(attempt: number): Promise<void> {
    const dependencies = this.dependencies;
    if (!dependencies) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        if (this.resetRetryTimer !== null) {
          dependencies.runtime.clearTimeout(this.resetRetryTimer);
          this.resetRetryTimer = null;
        }
        this.resetRetryWake = null;
        resolve();
      };
      this.resetRetryWake = wake;
      this.resetRetryTimer = dependencies.runtime.setTimeout(
        wake,
        this.retryDelayMs(attempt),
      );
    });
  }

  private async resetToOriginal(): Promise<StudioOperationResult> {
    const dependencies = this.dependencies;
    if (
      !dependencies?.cloud.reset ||
      this.resetInProgress ||
      this.projection.status !== "ready" ||
      (this.projection.ownership.kind !== "writer" &&
        this.projection.ownership.kind !== "degraded")
    ) {
      return { kind: "unavailable", reason: "invalid-state" };
    }
    this.resetInProgress = true;
    const expectedSessionGeneration = this.sessionGeneration;
    this.projection = { ...this.projection, status: "starting" };
    this.publish();

    const checkpoint = await this.waitForCloudCurrent("checkpoint");
    if (this.sessionGeneration !== expectedSessionGeneration) {
      this.resetInProgress = false;
      return { kind: "cloud-blocked", reason: "closed" };
    }
    if (checkpoint.kind !== "cloud-current") {
      this.resetInProgress = false;
      this.projection = { ...this.projection, status: "ready" };
      this.publish();
      return checkpoint;
    }

    let outcome: StudioCloudResetOutcome;
    let resetAttempt = 0;
    while (true) {
      if (this.sessionGeneration !== expectedSessionGeneration) {
        this.resetInProgress = false;
        return { kind: "cloud-blocked", reason: "closed" };
      }
      if (!(dependencies.runtime.isOnline?.() ?? true)) {
        outcome = { kind: "transient", reason: "offline" };
      } else {
        try {
          outcome = await dependencies.cloud.reset({
            baseRevision: checkpoint.revision,
          });
        } catch {
          outcome = { kind: "transient", reason: "network" };
        }
      }
      if (this.sessionGeneration !== expectedSessionGeneration) {
        this.resetInProgress = false;
        return { kind: "cloud-blocked", reason: "closed" };
      }
      if (outcome.kind !== "transient") break;
      this.projection = {
        ...this.projection,
        cloud: {
          ...this.projection.cloud,
          state: outcome.reason === "offline" ? "offline" : "retrying",
        },
      };
      this.publish();
      await this.waitForResetRetry(resetAttempt);
      resetAttempt += 1;
    }
    if (outcome.kind !== "reset") {
      this.resetInProgress = false;
      this.projection = { ...this.projection, status: "ready" };
      this.projectTerminalCloudOutcome(outcome, this.projection.cloud.dirty);
      this.publish();
      return (
        this.cloudTerminalResult() ?? {
          kind: "unavailable",
          reason: "invalid-state",
        }
      );
    }

    this.cloudRevision = outcome.revision;
    this.cloudDocument = ownDocument(outcome.document);
    this.unified = createUnifiedEditorHistory(
      ownDocument(outcome.document),
      ownSegments(this.seed.segments),
    );
    this.documentVersion += 1;
    this.cloudDirtySince = null;
    this.clearCloudTimers();
    this.unsubscribeOnline?.();
    this.unsubscribeOnline = null;
    dependencies.coordination.close();
    this.projection = {
      ...this.projection,
      status: "closed",
      ownership: {
        kind: "reader",
        generation: this.projection.ownership.generation,
      },
      cloud: {
        state: "current",
        revision: this.cloudRevision,
        dirty: false,
        rejectionCode: null,
      },
    };
    this.resetInProgress = false;
    this.publish();
    this.settleCloudWaiters();
    return {
      kind: "reset-complete",
      revision: this.cloudRevision,
      document: this.cloudDocument,
      reloadRequired: true,
    };
  }

  private publish(): void {
    if (this.playbackDocument !== this.unified.doc.present) {
      this.reconcilePlaybackAfterDocumentChange();
    }
    const preview = this.previewSnapshot();
    this.bindMediaToActiveAsset(preview);
    this.reconcileMediaAudio();
    const next = snapshotFor(
      this.unified,
      this.projection,
      preview,
      this.playback,
    );
    if (!snapshotsObservablyEqual(next, this.snapshot)) {
      this.snapshot = next;
      for (const listener of this.listeners) listener();
    }
    this.reconcileProxyPolling();
    this.reconcileAutomaticLayoutPolling();
  }

  private previewSnapshot(): StudioPreviewSnapshot {
    const document = this.unified.doc.present;
    const windowFingerprint = documentWindowFingerprint(this.unified.doc.present);
    const proxy =
      this.retainedProxy?.windowFingerprint === windowFingerprint
        ? this.retainedProxy
        : null;
    const activeAsset: StudioPreviewSnapshot["activeAsset"] = proxy
      ? { kind: "proxy", url: proxy.url, offsetSec: proxy.startSec }
      : (this.retainedProxy ||
            this.replacementSourceFallback ||
            this.manualSourceFallback) &&
          this.sourceUrl
        ? { kind: "source", url: this.sourceUrl, offsetSec: 0 }
        : { kind: "unavailable", url: null, offsetSec: 0 };
    const automaticLayout =
      this.retainedAutomaticLayout &&
      this.automaticLayoutMatchesDocument(
        this.retainedAutomaticLayout,
        document,
      )
        ? this.retainedAutomaticLayout
        : null;
    return deepFreeze({
      windowFingerprint,
      proxy,
      waveformPeaksUrl: proxy?.waveformPeaksUrl ?? null,
      automaticLayout,
      automaticLayoutStatus: automaticLayout
        ? "available"
        : this.automaticLayoutPollFailed
          ? "failed"
          : "pending",
      activeAsset,
    });
  }

  private playbackMapFor(document: EditorDocument): EditedTimeMap {
    const endSec =
      document.clipEndSec > document.clipStartSec
        ? document.clipEndSec
        : document.clipStartSec;
    return buildStudioCutPlan(document.deletedRanges, {
      startSec: document.clipStartSec,
      endSec,
    }).map;
  }

  private currentMediaBinding(): StudioMediaBinding {
    return deepFreeze({
      sessionGeneration: this.sessionGeneration,
      mediaGeneration: this.mediaGeneration,
    });
  }

  private replacePlayback(
    patch: Partial<Omit<StudioPlaybackSnapshot, "mediaBinding">> & {
      mediaBinding?: StudioMediaBinding;
    },
  ): void {
    this.playback = deepFreeze({
      ...this.playback,
      ...patch,
    });
  }

  private seekPlayback(editedTimeSec: number): void {
    const bounded = Number.isFinite(editedTimeSec)
      ? Math.max(0, Math.min(this.playbackMap.editedDurationSec, editedTimeSec))
      : 0;
    this.playbackSourceTimeSec = this.sourceAnchorForEditedTime(bounded);
    this.replacePlayback({ editedTimeSec: bounded });
    if (this.mediaAssetKey) {
      this.dependencies?.media?.command({
        type: "seek",
        binding: this.playback.mediaBinding,
        mediaTimeSec: this.playbackSourceTimeSec - this.mediaOffsetSec,
      });
    }
  }

  private play(): void {
    if (this.playback.editedTimeSec >= this.playback.durationSec - 0.02) {
      this.seekPlayback(0);
    }
    this.replacePlayback({ state: "playing" });
    if (this.mediaAssetKey) {
      this.dependencies?.media?.command({
        type: "play",
        binding: this.playback.mediaBinding,
      });
    }
  }

  private pause(): void {
    this.replacePlayback({ state: "paused" });
    if (this.mediaAssetKey) {
      this.dependencies?.media?.command({
        type: "pause",
        binding: this.playback.mediaBinding,
      });
    }
  }

  private reconcilePlaybackAfterDocumentChange(): void {
    if (
      playbackInputFingerprint(this.playbackDocument) ===
      playbackInputFingerprint(this.unified.doc.present)
    ) {
      this.playbackDocument = this.unified.doc.present;
      return;
    }
    const map = this.playbackMapFor(this.unified.doc.present);
    const wasPlaying = this.playback.state === "playing";
    let pauseForEndRelocation = false;
    this.playbackDocument = this.unified.doc.present;
    const containing = map.segments.find(
      (segment) =>
        this.playbackSourceTimeSec >= segment.sourceStartSec &&
        this.playbackSourceTimeSec < segment.sourceEndSec,
    );
    if (containing) {
      this.playbackMap = map;
      this.replacePlayback({
        editedTimeSec: sourceToEdited(map, this.playbackSourceTimeSec),
        durationSec: map.editedDurationSec,
      });
    } else {
      const next = map.segments.find(
        (segment) => segment.sourceStartSec >= this.playbackSourceTimeSec,
      );
      this.playbackMap = map;
      if (next) {
        this.playbackSourceTimeSec = next.sourceStartSec;
        this.replacePlayback({
          editedTimeSec: next.editedStartSec,
          durationSec: map.editedDurationSec,
        });
      } else if (map.segments.length > 0) {
        this.playbackSourceTimeSec = editedToSource(
          map,
          Math.max(0, map.editedDurationSec - 0.001),
        );
        this.replacePlayback({
          editedTimeSec: map.editedDurationSec,
          durationSec: map.editedDurationSec,
          state: "paused",
        });
        pauseForEndRelocation = wasPlaying;
      } else {
        this.playbackSourceTimeSec = map.clipStartSec;
        this.replacePlayback({
          editedTimeSec: 0,
          durationSec: 0,
          state: "paused",
        });
        pauseForEndRelocation = wasPlaying;
      }
    }
    if (this.mediaAssetKey) {
      if (pauseForEndRelocation) {
        this.dependencies?.media?.command({
          type: "pause",
          binding: this.playback.mediaBinding,
        });
      }
      this.dependencies?.media?.command({
        type: "seek",
        binding: this.playback.mediaBinding,
        mediaTimeSec: this.playbackSourceTimeSec - this.mediaOffsetSec,
      });
    }
  }

  private bindMediaToActiveAsset(preview: StudioPreviewSnapshot): void {
    const media = this.dependencies?.media;
    if (!media || this.projection.status === "closed") return;
    if (!this.unsubscribeMedia) {
      this.unsubscribeMedia = media.subscribe((event) => this.onMediaEvent(event));
    }
    const asset = preview.activeAsset;
    const key = asset.url ? `${asset.kind}:${asset.url}:${asset.offsetSec}` : null;
    if (
      key === this.mediaAssetKey &&
      this.playback.mediaBinding.sessionGeneration === this.sessionGeneration
    ) {
      return;
    }
    this.mediaAssetKey = key;
    this.mediaOffsetSec = asset.offsetSec;
    this.mediaGeneration += 1;
    const binding = this.currentMediaBinding();
    this.replacePlayback({ mediaBinding: binding });
    if (!asset.url) {
      media.command({ type: "unload", binding });
      return;
    }
    media.command({
      type: "load",
      binding,
      url: asset.url,
      mediaTimeSec: this.playbackSourceTimeSec - asset.offsetSec,
      rate: this.playback.rate,
      playing: this.playback.state === "playing",
      ...this.sourceAudioCommand(),
    });
    this.mediaAudioFingerprint = this.sourceAudioFingerprint();
  }

  private sourceAudioCommand(): { muted: boolean; volume: number } {
    const sourceAudio = this.unified.doc.present.studioEdits.sourceAudio;
    return {
      muted: sourceAudio.muted,
      volume: Math.max(0, Math.min(1, sourceAudio.volume / 100)),
    };
  }

  private sourceAudioFingerprint(): string {
    const audio = this.sourceAudioCommand();
    return `${audio.muted}:${audio.volume}`;
  }

  private reconcileMediaAudio(): void {
    if (!this.mediaAssetKey) return;
    const fingerprint = this.sourceAudioFingerprint();
    if (fingerprint === this.mediaAudioFingerprint) return;
    this.mediaAudioFingerprint = fingerprint;
    this.dependencies?.media?.command({
      type: "set-audio",
      binding: this.playback.mediaBinding,
      ...this.sourceAudioCommand(),
    });
  }

  private releaseMedia(): void {
    const media = this.dependencies?.media;
    if (media && this.mediaAssetKey) {
      media.command({ type: "pause", binding: this.playback.mediaBinding });
      media.command({ type: "unload", binding: this.playback.mediaBinding });
    }
    this.unsubscribeMedia?.();
    this.unsubscribeMedia = null;
    this.mediaAssetKey = null;
    this.mediaAudioFingerprint = null;
    this.replacePlayback({ state: "paused" });
  }

  private onMediaEvent(event: StudioMediaEvent): void {
    if (
      event.binding.sessionGeneration !== this.sessionGeneration ||
      event.binding.mediaGeneration !== this.mediaGeneration
    ) {
      return;
    }
    switch (event.type) {
      case "played":
        this.replacePlayback({ state: "playing" });
        break;
      case "paused":
        this.replacePlayback({ state: "paused" });
        break;
      case "ended":
        this.parkPlaybackAtEnd();
        break;
      case "seeked":
        this.pendingMediaSeekSourceSec = null;
        this.projectMediaTime(event.mediaTimeSec);
        return;
      case "time":
        this.projectMediaTime(event.mediaTimeSec);
        return;
    }
    this.publish();
  }

  private projectMediaTime(mediaTimeSec: number): void {
    const sourceTimeSec = mediaTimeSec + this.mediaOffsetSec;
    const step = stepRipple(this.playbackMap, sourceTimeSec);
    if (step.atEnd) {
      this.parkPlaybackAtEnd();
      this.publish();
      return;
    }
    if (step.skipToSourceSec !== undefined) {
      this.playbackSourceTimeSec = step.skipToSourceSec;
      if (
        this.pendingMediaSeekSourceSec === null ||
        Math.abs(this.pendingMediaSeekSourceSec - step.skipToSourceSec) >= 0.05
      ) {
        this.pendingMediaSeekSourceSec = step.skipToSourceSec;
        this.dependencies?.media?.command({
          type: "seek",
          binding: this.playback.mediaBinding,
          mediaTimeSec: step.skipToSourceSec - this.mediaOffsetSec,
        });
      }
    } else {
      this.pendingMediaSeekSourceSec = null;
      this.playbackSourceTimeSec = sourceTimeSec;
    }
    this.replacePlayback({ editedTimeSec: step.editedTime });
    this.publish();
  }

  private parkPlaybackAtEnd(): void {
    const editedTimeSec = this.playbackMap.editedDurationSec;
    this.playbackSourceTimeSec = this.sourceAnchorForEditedTime(editedTimeSec);
    this.pendingMediaSeekSourceSec = this.playbackSourceTimeSec;
    this.replacePlayback({ editedTimeSec, state: "paused" });
    if (this.mediaAssetKey) {
      this.dependencies?.media?.command({
        type: "pause",
        binding: this.playback.mediaBinding,
      });
      this.dependencies?.media?.command({
        type: "seek",
        binding: this.playback.mediaBinding,
        mediaTimeSec: this.playbackSourceTimeSec - this.mediaOffsetSec,
      });
    }
  }

  private sourceAnchorForEditedTime(editedTimeSec: number): number {
    const durationSec = this.playbackMap.editedDurationSec;
    const anchoredEditedTimeSec =
      durationSec > 0 && editedTimeSec >= durationSec
        ? Math.max(0, durationSec - 0.001)
        : editedTimeSec;
    return editedToSource(this.playbackMap, anchoredEditedTimeSec);
  }

  private retireDerivedAssetsForAcknowledgedChange(
    previous: EditorDocument,
    current: EditorDocument,
  ): void {
    if (
      documentWindowFingerprint(previous) !==
      documentWindowFingerprint(current)
    ) {
      this.retainedProxy = null;
      this.replacementSourceFallback = true;
    }
    if (
      previous.clipStartSec !== current.clipStartSec ||
      previous.clipEndSec !== current.clipEndSec ||
      JSON.stringify(previous.deletedRanges) !==
        JSON.stringify(current.deletedRanges)
    ) {
      this.retainedAutomaticLayout = null;
    }
  }

  private reconcileProxyPolling(): void {
    const dependencies = this.dependencies;
    const target = documentWindowFingerprint(this.unified.doc.present);
    const cloudTarget = documentWindowFingerprint(this.cloudDocument);
    const proxyIsEligible = this.retainedProxy?.windowFingerprint === target;
    const shouldPoll =
      Boolean(dependencies?.preview?.fetchProxyStatus) &&
      !this.sourcePurged &&
      this.projection.status === "ready" &&
      !proxyIsEligible &&
      target === cloudTarget;
    if (!shouldPoll) {
      if (this.proxyPollTarget !== null) this.clearProxyPolling();
      return;
    }
    if (!dependencies) return;
    if (this.proxyPollTarget !== target) {
      this.clearProxyPolling();
      this.proxyPollTarget = target;
    }
    if (
      !dependencies?.preview?.fetchProxyStatus ||
      this.proxyPollTimer !== null ||
      this.proxyPollRunning ||
      this.proxyPollAttempts >= PREVIEW_POLL_MAX_ATTEMPTS
    ) {
      return;
    }
    const pollGeneration = this.proxyPollGeneration;
    this.proxyPollTimer = dependencies.runtime.setTimeout(() => {
      this.proxyPollTimer = null;
      void this.pollProxy(target, pollGeneration);
    }, PREVIEW_POLL_INTERVAL_MS);
  }

  private async pollProxy(
    target: StudioDocumentWindowFingerprint,
    pollGeneration: number,
  ): Promise<void> {
    const dependencies = this.dependencies;
    if (!dependencies?.preview?.fetchProxyStatus) return;
    const expectedSessionGeneration = this.sessionGeneration;
    this.proxyPollRunning = true;
    this.proxyPollAttempts += 1;
    let status: StudioProxyStatus | null = null;
    try {
      status = await dependencies.preview.fetchProxyStatus();
    } catch {
      // Readiness is eventually consistent; a later bounded poll may succeed.
    }
    if (
      this.proxyPollGeneration !== pollGeneration ||
      this.sessionGeneration !== expectedSessionGeneration ||
      this.proxyPollTarget !== target
    ) {
      return;
    }
    this.proxyPollRunning = false;
    if (
      status?.previewUrl &&
      documentWindowFingerprint(this.unified.doc.present) === target &&
      documentWindowFingerprint(this.cloudDocument) === target
    ) {
      this.retainedProxy = deepFreeze({
        url: status.previewUrl,
        startSec: status.previewStartSec,
        durationSec: status.previewDurationSec,
        waveformPeaksUrl: status.waveformPeaksUrl,
        windowFingerprint: target,
      });
      this.replacementSourceFallback = false;
      this.publish();
      return;
    }
    this.reconcileProxyPolling();
  }

  private clearProxyPolling(): void {
    if (this.proxyPollTimer !== null && this.dependencies) {
      this.dependencies.runtime.clearTimeout(this.proxyPollTimer);
    }
    this.proxyPollTimer = null;
    this.proxyPollTarget = null;
    this.proxyPollAttempts = 0;
    this.proxyPollRunning = false;
    this.proxyPollGeneration += 1;
  }

  private reconcileAutomaticLayoutPolling(): void {
    const dependencies = this.dependencies;
    const document = this.unified.doc.present;
    const target = automaticLayoutInputFingerprint(document);
    const cloudTarget = automaticLayoutInputFingerprint(this.cloudDocument);
    const proxyIsEligible =
      this.retainedProxy?.windowFingerprint ===
      documentWindowFingerprint(document);
    const automaticLayoutIsEligible = Boolean(
      this.retainedAutomaticLayout &&
        this.automaticLayoutMatchesDocument(
          this.retainedAutomaticLayout,
          document,
        ),
    );
    const shouldPoll =
      Boolean(dependencies?.preview?.fetchAutomaticLayout) &&
      this.projection.status === "ready" &&
      proxyIsEligible &&
      !automaticLayoutIsEligible &&
      target === cloudTarget;
    if (!shouldPoll) {
      if (this.automaticLayoutPollTarget !== null) {
        this.clearAutomaticLayoutPolling();
      }
      return;
    }
    if (!dependencies) return;
    if (this.automaticLayoutPollTarget !== target) {
      this.clearAutomaticLayoutPolling();
      this.automaticLayoutPollTarget = target;
      this.automaticLayoutPollDeadline =
        dependencies.runtime.now() + AUTO_LAYOUT_POLL_DEADLINE_MS;
      const deadlineGeneration = this.automaticLayoutPollGeneration;
      this.automaticLayoutDeadlineTimer = dependencies.runtime.setTimeout(
        () => {
          this.automaticLayoutDeadlineTimer = null;
          if (
            this.automaticLayoutPollGeneration !== deadlineGeneration ||
            this.automaticLayoutPollTarget !== target
          ) {
            return;
          }
          if (this.automaticLayoutPollTimer !== null) {
            dependencies.runtime.clearTimeout(this.automaticLayoutPollTimer);
            this.automaticLayoutPollTimer = null;
          }
          this.automaticLayoutPollFailed = true;
          this.publish();
        },
        AUTO_LAYOUT_POLL_DEADLINE_MS,
      );
    }
    if (dependencies.runtime.now() >= this.automaticLayoutPollDeadline) {
      if (!this.automaticLayoutPollFailed) {
        this.automaticLayoutPollFailed = true;
        this.publish();
      }
      return;
    }
    if (
      !dependencies?.preview?.fetchAutomaticLayout ||
      this.automaticLayoutPollTimer !== null ||
      this.automaticLayoutPollRunning
    ) {
      return;
    }
    const pollGeneration = this.automaticLayoutPollGeneration;
    const delayMs = this.automaticLayoutPollDelayMs;
    this.automaticLayoutPollDelayMs = Math.min(
      AUTO_LAYOUT_POLL_MAX_MS,
      Math.round(delayMs * 1.7),
    );
    this.automaticLayoutPollTimer = dependencies.runtime.setTimeout(() => {
      this.automaticLayoutPollTimer = null;
      void this.pollAutomaticLayout(target, pollGeneration);
    }, delayMs);
  }

  private async pollAutomaticLayout(
    target: string,
    pollGeneration: number,
  ): Promise<void> {
    const dependencies = this.dependencies;
    if (!dependencies?.preview?.fetchAutomaticLayout) return;
    const expectedSessionGeneration = this.sessionGeneration;
    this.automaticLayoutPollRunning = true;
    let analysis: ClipAutoLayoutAnalysis | null = null;
    try {
      analysis = await dependencies.preview.fetchAutomaticLayout();
    } catch {
      // Readiness is eventually consistent; a later bounded poll may succeed.
    }
    if (
      this.automaticLayoutPollGeneration !== pollGeneration ||
      this.sessionGeneration !== expectedSessionGeneration ||
      this.automaticLayoutPollTarget !== target
    ) {
      return;
    }
    this.automaticLayoutPollRunning = false;
    const document = this.unified.doc.present;
    if (dependencies.runtime.now() >= this.automaticLayoutPollDeadline) {
      if (!this.automaticLayoutPollFailed) {
        this.automaticLayoutPollFailed = true;
        this.publish();
      }
      return;
    }
    if (
      analysis &&
      automaticLayoutInputFingerprint(document) === target &&
      automaticLayoutInputFingerprint(this.cloudDocument) === target &&
      this.automaticLayoutMatchesDocument(analysis, document)
    ) {
      this.retainedAutomaticLayout = deepFreeze(structuredClone(analysis));
      this.publish();
      return;
    }
    this.reconcileAutomaticLayoutPolling();
  }

  private clearAutomaticLayoutPolling(): void {
    if (this.automaticLayoutPollTimer !== null && this.dependencies) {
      this.dependencies.runtime.clearTimeout(this.automaticLayoutPollTimer);
    }
    if (this.automaticLayoutDeadlineTimer !== null && this.dependencies) {
      this.dependencies.runtime.clearTimeout(this.automaticLayoutDeadlineTimer);
    }
    this.automaticLayoutPollTimer = null;
    this.automaticLayoutDeadlineTimer = null;
    this.automaticLayoutPollTarget = null;
    this.automaticLayoutPollDeadline = 0;
    this.automaticLayoutPollDelayMs = AUTO_LAYOUT_POLL_INITIAL_MS;
    this.automaticLayoutPollRunning = false;
    this.automaticLayoutPollFailed = false;
    this.automaticLayoutPollGeneration += 1;
  }

  private automaticLayoutMatchesDocument(
    analysis: ClipAutoLayoutAnalysis,
    document: EditorDocument,
  ): boolean {
    return (
      (this.automaticLayoutSourceIdentity === null ||
        analysis.sourceIdentity === this.automaticLayoutSourceIdentity) &&
      clipAutoLayoutMatchesInputs(analysis, {
        clipStartSec: document.clipStartSec,
        clipEndSec: document.clipEndSec,
        deletedRanges: document.deletedRanges,
      })
    );
  }

  private clearDerivedPolling(): void {
    this.clearProxyPolling();
    this.clearAutomaticLayoutPolling();
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
        documentVersion: this.documentVersion,
        cloudRevision: this.cloudRevision,
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
    this.clearCloudTimers();
    this.clearDerivedPolling();
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
    this.settleCloudWaiters();
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
    this.unsubscribeOnline = dependencies.runtime.subscribeOnline?.((online) => {
      if (!online) {
        if (this.projection.cloud.dirty) {
          this.projection = {
            ...this.projection,
            cloud: { ...this.projection.cloud, state: "offline" },
          };
          this.publish();
        }
        return;
      }
      this.cloudRefreshRetryWake?.();
      this.resetRetryWake?.();
      if (
        this.projection.cloud.dirty &&
        (this.projection.cloud.state === "offline" ||
          this.projection.cloud.state === "retrying")
      ) {
        this.wakeCloudCheckpoint();
      }
    }) ?? null;
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
        cloud: {
          state: "current",
          revision: this.cloudRevision,
          dirty: false,
          rejectionCode: null,
        },
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
    if (this.projection.cloud.dirty) this.scheduleCloudAutosave();
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
      cloud: this.documentsEqual(document, input.cloudDocument)
        ? {
            state: "current",
            revision: input.cloudRevision,
            dirty: false,
            rejectionCode: null,
          }
        : {
            state: this.dependencies?.runtime.isOnline?.() === false
              ? "offline"
              : "pending",
            revision: input.cloudRevision,
            dirty: true,
            rejectionCode: null,
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
    if (
      cloudResult.head.revision < this.cloudRevision ||
      (cloudResult.head.revision === this.cloudRevision &&
        !this.documentsEqual(cloudResult.head.document, this.cloudDocument))
    ) {
      this.diagnose("studio_takeover_cloud_refresh_stale", "unavailable");
      dependencies.coordination.relinquish?.();
      this.loseOwnership();
      return { kind: "unavailable", reason: "invalid-state" };
    }

    this.retireDerivedAssetsForAcknowledgedChange(
      this.cloudDocument,
      cloudResult.head.document,
    );
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
    if (this.projection.cloud.dirty) this.scheduleCloudAutosave();
    return {
      kind: "ownership-acquired",
      forced: acquired.forced,
      cloudRevision: this.cloudRevision,
      cloudDocument: this.cloudDocument,
    };
  }

  private async removeObsoleteDeviceDraft(): Promise<DraftRemovalOutcome> {
    const dependencies = this.dependencies;
    const generation = this.projection.ownership.generation;
    if (!dependencies || generation === null) {
      this.projection = {
        ...this.projection,
        durability: { device: "durable", protectsNavigation: false },
      };
      return "removed";
    }
    try {
      const outcome = await dependencies.drafts.remove(
        this.deviceDraftKey,
        generation,
      );
      if (outcome === "stale") {
        this.diagnose("studio_cloud_current_draft_remove_rejected", "stale");
        dependencies.coordination.relinquish?.();
        this.loseOwnership();
        return "stale";
      }
      this.projection = {
        ...this.projection,
        durability: { device: "durable", protectsNavigation: false },
      };
      return "removed";
    } catch (error) {
      this.deviceDraftAvailable = false;
      this.projection = {
        ...this.projection,
        durability: { device: "degraded", protectsNavigation: true },
      };
      this.diagnose(
        "studio_cloud_current_draft_remove_failed",
        "degraded",
        error,
      );
      return "unavailable";
    }
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
  return session;
}
