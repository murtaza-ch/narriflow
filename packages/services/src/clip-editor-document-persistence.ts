import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  CLIP_MAX_DURATION_SEC,
  CLIP_MIN_DURATION_SEC,
  DEFAULT_CAPTION_PRESET,
  applyStudioEditsPatchSchema,
  captionPresetSchema,
  deletedRangesEqual,
  deletedRangesSchema,
  editorDocumentSchema,
  editorDocumentsEqual,
  getEffectiveClipTiming,
  hasRenderableContent,
  mergeCorrectedWordsIntoWindow,
  normalizeDeletedRanges,
  normalizeTranscriptSliceForClip,
  splitUtterancesIntoSentences,
  studioEditsSchema,
  updateClipBoundariesSchema,
  updateClipTranscriptSliceSchema,
  type EditorDocument,
  type ApplyStudioEditsPatch,
  type ClipStatus,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { assertPublicHttpUrl, UnsafeUrlError } from "./url-guard";
import { tryDerivePeaksStorageKey } from "./clip-preview-storage";
import { computeDurationOptimality, computePlatformScore } from "./clip-scoring";
import {
  admitMediaCleanupObligations,
  type MediaCleanupObligationInput,
} from "./media-cleanup";
import { accessibleProjectWhere } from "./project-access";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

const clipEditorDocumentPersistenceFailureCatalog = {
  clip_not_found: "missing",
  project_not_found: "missing",
  corrupt_stored_document: "unprocessable",
  unsupported_editor_document_version: "unprocessable",
  editor_document_invalid: "unprocessable",
  editor_boundaries_invalid: "unprocessable",
  editor_document_empty_timeline: "unprocessable",
  retryable_contention: "unavailable",
  persistence_unavailable: "unavailable",
  editor_revision_conflict: "conflict",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type ClipEditorDocumentPersistenceErrorCode =
  keyof typeof clipEditorDocumentPersistenceFailureCatalog;

export class ClipEditorRevisionConflictError extends ExpectedDomainFailureError<
  ClipEditorDocumentPersistenceErrorCode,
  { currentRevision: number }
> {
  constructor(currentRevision: number) {
    const code = "editor_revision_conflict" as const;
    super({
      code,
      kind: clipEditorDocumentPersistenceFailureCatalog[code],
      message: "The clip changed before the edit was saved",
      details: { currentRevision },
    });
    this.name = "ClipEditorRevisionConflictError";
  }
}

export class ClipEditorDocumentPersistenceError extends ExpectedDomainFailureError<
  ClipEditorDocumentPersistenceErrorCode,
  { retryable: boolean }
> {
  constructor(
    code: ClipEditorDocumentPersistenceErrorCode,
    message: string,
  ) {
    const retryable =
      code === "retryable_contention" || code === "persistence_unavailable";
    super({
      code,
      kind: clipEditorDocumentPersistenceFailureCatalog[code],
      message,
      details: { retryable },
    });
    this.name = "ClipEditorDocumentPersistenceError";
  }
}

export interface ClipEditorDocumentStoredState {
  workspaceId: string;
  workspaceOwnerUserId: string;
  projectId: string;
  clipId: string;
  revision: number;
  document: EditorDocument;
  original: EditorDocument | null;
  sourceDurationSec: number | null;
  sourceStorageKey: string | null;
  sourceTranscript: TranscriptUtterance[];
  viralityScore: number;
  status: ClipStatus;
  preview: {
    storageKey: string | null;
    startSec: number | null;
    durationSec: number | null;
  };
  evidence: {
    screen: unknown | null;
    automatic: unknown | null;
    split: unknown | null;
  };
  scores: {
    durationOptimality: number;
    tiktok: number;
    youtube: number;
    instagram: number;
  };
  mutableRenders: Array<{ id: string; storageKey: string | null }>;
}

export interface ClipEditorDocumentActorScope {
  actorUserId: string;
  workspaceId: string;
  workspaceOwnerUserId: string;
}

export interface ClipEditorDocumentScope extends ClipEditorDocumentActorScope {
  projectId: string;
  clipId: string;
}

export type ClipEditorDocumentMutationIntent =
  | { kind: "replace"; baseRevision: number; document: EditorDocument }
  | { kind: "reset"; baseRevision: number }
  | { kind: "set_boundaries"; startSec: number; endSec: number }
  | { kind: "set_transcript"; transcriptSlice: TranscriptUtterance[] }
  | {
      kind: "set_caption_preset";
      captionPreset: EditorDocument["captionPreset"] | null;
    }
  | { kind: "set_broll_url"; brollUrl: string | null }
  | { kind: "set_studio_edits"; studioEdits: EditorDocument["studioEdits"] };

export type ClipEditorProjectSelectionIntent =
  | { kind: "set_caption_preset"; captionPreset: EditorDocument["captionPreset"] }
  | {
      kind: "patch_studio_edits";
      patches: ReadonlyArray<ApplyStudioEditsPatch>;
    };

export interface ClipEditorDocumentMutationResult {
  revision: number;
  document: EditorDocument;
  noop: boolean;
}

interface ClipEditorDocumentCommit {
  scope: ClipEditorDocumentScope;
  expectedRevision: number;
  nextDocument: EditorDocument;
  captureOriginal: EditorDocument | null;
  retirePreview: boolean;
  retireEvidence: boolean;
  scores: ClipEditorDocumentStoredState["scores"];
  cleanupIntents: MediaCleanupObligationInput[];
}

interface ClipEditorProjectSelectionScope extends ClipEditorDocumentActorScope {
  projectId: string;
  excludeClipId?: string;
}

interface ClipEditorProjectSelectionCommit {
  scope: ClipEditorProjectSelectionScope;
  expectedRevisions: Array<{ clipId: string; revision: number }>;
  documents: ClipEditorDocumentCommit[];
}

export interface ClipEditorDocumentStore {
  read(scope: ClipEditorDocumentScope): Promise<ClipEditorDocumentStoredState | null>;
  confirmRevision(scope: ClipEditorDocumentScope, expectedRevision: number): Promise<boolean>;
  commit(input: ClipEditorDocumentCommit): Promise<ClipEditorDocumentStoredState | null>;
  readProjectSelection(
    scope: ClipEditorProjectSelectionScope,
  ): Promise<ClipEditorDocumentStoredState[] | null>;
  commitProjectSelection(input: ClipEditorProjectSelectionCommit): Promise<boolean>;
}

export interface ClipEditorDocumentDiagnostics {
  record(event: {
    actorUserId: string;
    projectId: string;
    clipId: string | null;
    mutationKind:
      | ClipEditorDocumentMutationIntent["kind"]
      | `project_${ClipEditorProjectSelectionIntent["kind"]}`;
    attempt: number;
    baseRevision: number | null;
    resultingRevision: number;
    noop: boolean;
    invalidationClasses: string[];
    cleanupCount: number;
    outcome: "accepted" | "conflict" | "rejected";
    elapsedMs: number;
  }): void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function persistenceError(
  code: ClipEditorDocumentPersistenceErrorCode,
  message: string,
): never {
  throw new ClipEditorDocumentPersistenceError(code, message);
}

function assertDocumentWindow(
  document: EditorDocument,
  sourceDurationSec: number | null,
): void {
  const durationSec = document.clipEndSec - document.clipStartSec;
  if (
    durationSec < CLIP_MIN_DURATION_SEC - 0.001 ||
    durationSec > CLIP_MAX_DURATION_SEC + 0.001 ||
    (sourceDurationSec !== null && document.clipEndSec > sourceDurationSec + 0.001)
  ) {
    persistenceError(
      "editor_boundaries_invalid",
      "clip boundaries are outside the renderable source window",
    );
  }
}

function canonicalizeDocument(
  value: unknown,
  sourceDurationSec: number | null,
): EditorDocument {
  const parsed = editorDocumentSchema.safeParse(value);
  if (!parsed.success) {
    persistenceError("corrupt_stored_document", "Clip Editor Document is malformed");
  }
  assertDocumentWindow(parsed.data, sourceDurationSec);
  for (const externalUrl of [
    parsed.data.brollUrl,
    parsed.data.studioEdits.music.url,
    parsed.data.studioEdits.background.imageUrl,
  ]) {
    if (externalUrl !== null) assertPublicHttpUrl(externalUrl);
  }
  const window = {
    startSec: parsed.data.clipStartSec,
    endSec: parsed.data.clipEndSec,
  };
  const canonical = editorDocumentSchema.parse({
    ...parsed.data,
    transcriptSlice: normalizeTranscriptSliceForClip(
      parsed.data.transcriptSlice,
      window.startSec,
      window.endSec,
    ),
    deletedRanges: normalizeDeletedRanges(parsed.data.deletedRanges, window),
  });
  if (!hasRenderableContent(window, canonical.deletedRanges)) {
    persistenceError(
      "editor_document_empty_timeline",
      "deleting these ranges would leave nothing in the clip to render",
    );
  }
  return canonical;
}

function durationScores(
  state: ClipEditorDocumentStoredState,
  document: EditorDocument,
): ClipEditorDocumentStoredState["scores"] {
  const durationSec = document.clipEndSec - document.clipStartSec;
  return {
    durationOptimality: computeDurationOptimality(durationSec),
    tiktok: computePlatformScore(state.viralityScore, durationSec, "tiktok"),
    youtube: computePlatformScore(state.viralityScore, durationSec, "youtube"),
    instagram: computePlatformScore(state.viralityScore, durationSec, "instagram"),
  };
}

function cleanupIntents(
  state: ClipEditorDocumentStoredState,
  retirePreview: boolean,
): MediaCleanupObligationInput[] {
  const obligation = (
    cleanupClass: MediaCleanupObligationInput["cleanupClass"],
    objectKey: string,
  ): MediaCleanupObligationInput => ({
    origin: "clip_editor_document_persistence",
    projectId: state.projectId,
    clipId: state.clipId,
    cleanupClass,
    objectKey,
  });
  const intents: MediaCleanupObligationInput[] = state.mutableRenders.flatMap((render) =>
    render.storageKey
      ? [obligation("mutable_render", render.storageKey)]
      : [],
  );
  if (retirePreview && state.preview.storageKey) {
    intents.push(obligation("preview_proxy", state.preview.storageKey));
    const peaksKey = tryDerivePeaksStorageKey(state.preview.storageKey);
    if (peaksKey) intents.push(obligation("preview_peaks", peaksKey));
  }
  return [...new Map(intents.map((intent) => [intent.objectKey, intent])).values()];
}

function planNextDocument(
  state: ClipEditorDocumentStoredState,
  intent: ClipEditorDocumentMutationIntent,
): EditorDocument | null {
  if (intent.kind === "replace") {
    return canonicalizeDocument(intent.document, state.sourceDurationSec);
  }
  if (intent.kind === "reset") {
    return state.original
      ? canonicalizeDocument(state.original, state.sourceDurationSec)
      : null;
  }
  if (intent.kind === "set_boundaries") {
    const requested = updateClipBoundariesSchema.safeParse(intent);
    if (!requested.success) {
      persistenceError("editor_boundaries_invalid", "clip boundaries are invalid");
    }
    if (
      state.sourceDurationSec !== null &&
      requested.data.endSec > state.sourceDurationSec + 0.001
    ) {
      persistenceError(
        "editor_boundaries_invalid",
        "clip boundaries extend beyond the source duration",
      );
    }
    const effective = getEffectiveClipTiming({
      utterances: splitUtterancesIntoSentences(state.sourceTranscript),
      startSec: requested.data.startSec,
      endSec: requested.data.endSec,
      sourceDurationSec: state.sourceDurationSec,
    });
    return canonicalizeDocument(
      {
        ...state.document,
        clipStartSec: effective.startSec,
        clipEndSec: effective.endSec,
        transcriptSlice:
          state.sourceTranscript.length > 0
            ? mergeCorrectedWordsIntoWindow(
                effective.transcriptSlice,
                state.document.transcriptSlice,
              )
            : [],
        deletedRanges: normalizeDeletedRanges(state.document.deletedRanges, {
          startSec: effective.startSec,
          endSec: effective.endSec,
        }),
      },
      state.sourceDurationSec,
    );
  }
  if (intent.kind === "set_caption_preset") {
    return canonicalizeDocument(
      {
        ...state.document,
        captionPreset: intent.captionPreset ?? DEFAULT_CAPTION_PRESET,
      },
      state.sourceDurationSec,
    );
  }
  if (intent.kind === "set_broll_url") {
    return canonicalizeDocument(
      { ...state.document, brollUrl: intent.brollUrl },
      state.sourceDurationSec,
    );
  }
  if (intent.kind === "set_studio_edits") {
    return canonicalizeDocument(
      { ...state.document, studioEdits: intent.studioEdits },
      state.sourceDurationSec,
    );
  }
  const parsed = updateClipTranscriptSliceSchema.safeParse({
    transcriptSlice: intent.transcriptSlice,
  });
  if (!parsed.success) {
    persistenceError("corrupt_stored_document", "transcript mutation is malformed");
  }
  return canonicalizeDocument(
    {
      ...state.document,
      transcriptSlice: normalizeTranscriptSliceForClip(
        parsed.data.transcriptSlice,
        state.document.clipStartSec,
        state.document.clipEndSec,
      ),
    },
    state.sourceDurationSec,
  );
}

function planProjectSelectionDocument(
  state: ClipEditorDocumentStoredState,
  intent: ClipEditorProjectSelectionIntent,
): EditorDocument {
  if (intent.kind === "set_caption_preset") {
    return canonicalizeDocument(
      { ...state.document, captionPreset: intent.captionPreset },
      state.sourceDurationSec,
    );
  }
  if (intent.patches.length === 0) {
    persistenceError("editor_document_invalid", "Studio edit patches cannot be empty");
  }
  let studioEdits = state.document.studioEdits;
  for (const patch of intent.patches) {
    const parsed = applyStudioEditsPatchSchema.safeParse(patch);
    if (!parsed.success) {
      persistenceError("editor_document_invalid", "Studio edit patch is malformed");
    }
    studioEdits = { ...studioEdits, ...parsed.data };
  }
  return canonicalizeDocument(
    { ...state.document, studioEdits },
    state.sourceDurationSec,
  );
}

function canonicalizeStoredState(
  state: ClipEditorDocumentStoredState,
): ClipEditorDocumentStoredState {
  try {
    return {
      ...state,
      document: canonicalizeDocument(state.document, state.sourceDurationSec),
      original:
        state.original !== null
          ? canonicalizeDocument(state.original, state.sourceDurationSec)
          : null,
    };
  } catch (error) {
    if (
      error instanceof ClipEditorDocumentPersistenceError ||
      error instanceof UnsafeUrlError
    ) {
      throw error;
    }
    throw new ClipEditorDocumentPersistenceError(
      "corrupt_stored_document",
      "Clip Editor Document is malformed",
    );
  }
}

function safeRecord(
  diagnostics: ClipEditorDocumentDiagnostics | undefined,
  event: Parameters<ClipEditorDocumentDiagnostics["record"]>[0],
): void {
  try {
    diagnostics?.record(event);
  } catch {
    // Diagnostics cannot change mutation settlement.
  }
}

export function createClipEditorDocumentPersistence(input: {
  store: ClipEditorDocumentStore;
  diagnostics?: ClipEditorDocumentDiagnostics;
  now?: () => Date;
  fieldRetryLimit?: number;
}) {
  const now = input.now ?? (() => new Date());
  const fieldRetryLimit = input.fieldRetryLimit ?? 3;
  if (!Number.isSafeInteger(fieldRetryLimit) || fieldRetryLimit < 1 || fieldRetryLimit > 10) {
    throw new RangeError("fieldRetryLimit must be an integer between 1 and 10");
  }

  async function readState(scope: ClipEditorDocumentScope) {
    const state = await input.store.read(scope);
    if (!state) persistenceError("clip_not_found", "clip not found");
    return canonicalizeStoredState(state);
  }

  async function mutateDocument(
    request: ClipEditorDocumentScope & { intent: ClipEditorDocumentMutationIntent },
  ): Promise<ClipEditorDocumentMutationResult> {
    const startedAt = now().getTime();
    const baseRevision =
      request.intent.kind === "replace" || request.intent.kind === "reset"
        ? request.intent.baseRevision
        : null;
    const attempts = baseRevision === null ? fieldRetryLimit : 1;
    let lastRevision = -1;
    const record = (
      event: Omit<
        Parameters<ClipEditorDocumentDiagnostics["record"]>[0],
        | "actorUserId"
        | "projectId"
        | "clipId"
        | "mutationKind"
        | "baseRevision"
        | "elapsedMs"
      >,
    ) =>
      safeRecord(input.diagnostics, {
        actorUserId: request.actorUserId,
        projectId: request.projectId,
        clipId: request.clipId,
        mutationKind: request.intent.kind,
        baseRevision,
        elapsedMs: now().getTime() - startedAt,
        ...event,
      });
    const acceptNoopIfCurrent = async (
      state: ClipEditorDocumentStoredState,
      attempt: number,
    ): Promise<ClipEditorDocumentMutationResult | null> => {
      let confirmed: boolean;
      try {
        confirmed = await input.store.confirmRevision(request, state.revision);
      } catch (error) {
        record({
          attempt,
          resultingRevision: state.revision,
          noop: false,
          invalidationClasses: [],
          cleanupCount: 0,
          outcome: "rejected",
        });
        throw error;
      }
      if (!confirmed) {
        if (baseRevision !== null) {
          const latest = await readState(request);
          record({
            attempt,
            resultingRevision: latest.revision,
            noop: false,
            invalidationClasses: [],
            cleanupCount: 0,
            outcome: "conflict",
          });
          throw new ClipEditorRevisionConflictError(latest.revision);
        }
        return null;
      }
      record({
        attempt,
        resultingRevision: state.revision,
        noop: true,
        invalidationClasses: [],
        cleanupCount: 0,
        outcome: "accepted",
      });
      return { revision: state.revision, document: state.document, noop: true };
    };

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = await readState(request);
      lastRevision = state.revision;
      let next: EditorDocument | null;
      try {
        next = planNextDocument(state, request.intent);
      } catch (error) {
        record({
          attempt: attempt + 1,
          resultingRevision: state.revision,
          noop: false,
          invalidationClasses: [],
          cleanupCount: 0,
          outcome: "rejected",
        });
        throw error;
      }
      if (next === null) {
        if (
          request.intent.kind === "reset" &&
          state.revision !== request.intent.baseRevision
        ) {
          record({
            attempt: attempt + 1,
            resultingRevision: state.revision,
            noop: false,
            invalidationClasses: [],
            cleanupCount: 0,
            outcome: "conflict",
          });
          throw new ClipEditorRevisionConflictError(state.revision);
        }
        const accepted = await acceptNoopIfCurrent(state, attempt + 1);
        if (accepted) return accepted;
        continue;
      }

      if (editorDocumentsEqual(state.document, next)) {
        const accepted = await acceptNoopIfCurrent(state, attempt + 1);
        if (accepted) return accepted;
        continue;
      }

      if (
        (request.intent.kind === "replace" || request.intent.kind === "reset") &&
        state.revision !== request.intent.baseRevision
      ) {
        record({
          attempt: attempt + 1,
          resultingRevision: state.revision,
          noop: false,
          invalidationClasses: [],
          cleanupCount: 0,
          outcome: "conflict",
        });
        throw new ClipEditorRevisionConflictError(state.revision);
      }

      const windowChanged =
        state.document.clipStartSec !== next.clipStartSec ||
        state.document.clipEndSec !== next.clipEndSec;
      if (windowChanged && !state.sourceStorageKey) {
        persistenceError(
          "editor_boundaries_invalid",
          "clip boundaries cannot change after source media removal",
        );
      }
      const deletedRangesChanged =
        !windowChanged &&
        !deletedRangesEqual(state.document.deletedRanges, next.deletedRanges, {
          startSec: state.document.clipStartSec,
          endSec: state.document.clipEndSec,
        });
      const retireEvidence = windowChanged || deletedRangesChanged;
      const cleanup = cleanupIntents(state, windowChanged);
      let committed: ClipEditorDocumentStoredState | null;
      try {
        committed = await input.store.commit({
          scope: request,
          expectedRevision: state.revision,
          nextDocument: next,
          captureOriginal: state.original ? null : state.document,
          retirePreview: windowChanged,
          retireEvidence,
          scores: windowChanged ? durationScores(state, next) : state.scores,
          cleanupIntents: cleanup,
        });
      } catch (error) {
        record({
          attempt: attempt + 1,
          resultingRevision: state.revision,
          noop: false,
          invalidationClasses: [],
          cleanupCount: 0,
          outcome: "rejected",
        });
        throw error;
      }
      if (!committed) {
        if (baseRevision !== null) {
          const latest = await readState(request);
          record({
            attempt: attempt + 1,
            resultingRevision: latest.revision,
            noop: false,
            invalidationClasses: [],
            cleanupCount: 0,
            outcome: "conflict",
          });
          throw new ClipEditorRevisionConflictError(latest.revision);
        }
        continue;
      }

      const invalidationClasses = ["mutable_renders"];
      if (windowChanged) invalidationClasses.push("preview", "duration_scores");
      if (retireEvidence) invalidationClasses.push("composition_evidence");
      record({
        attempt: attempt + 1,
        resultingRevision: committed.revision,
        noop: false,
        invalidationClasses,
        cleanupCount: cleanup.length,
        outcome: "accepted",
      });
      return {
        revision: committed.revision,
        document: committed.document,
        noop: false,
      };
    }
    record({
      attempt: attempts,
      resultingRevision: lastRevision,
      noop: false,
      invalidationClasses: [],
      cleanupCount: 0,
      outcome: "conflict",
    });
    persistenceError(
      "retryable_contention",
      "Clip Editor Document changed repeatedly; retry the mutation",
    );
  }

  return {
    async readDocument(scope: ClipEditorDocumentScope) {
      const state = await readState(scope);
      return {
        revision: state.revision,
        document: state.document,
        original: state.original ?? state.document,
        evidence: state.evidence,
      };
    },
    mutateDocument,
    async mutateProjectSelection(request: {
      actorUserId: string;
      workspaceId: string;
      workspaceOwnerUserId: string;
      projectId: string;
      excludeClipId?: string;
      intent: ClipEditorProjectSelectionIntent;
    }): Promise<{ updated: number }> {
      const startedAt = now().getTime();
      const mutationKind =
        request.intent.kind === "set_caption_preset"
          ? "project_set_caption_preset" as const
          : "project_patch_studio_edits" as const;
      let lastStates: ClipEditorDocumentStoredState[] = [];
      for (let attempt = 0; attempt < fieldRetryLimit; attempt += 1) {
        const storedStates = await input.store.readProjectSelection(request);
        if (!storedStates) persistenceError("project_not_found", "project not found");
        const states = storedStates.map(canonicalizeStoredState);
        lastStates = states;
        const documents = states.flatMap((state) => {
          const nextDocument = planProjectSelectionDocument(state, request.intent);
          if (editorDocumentsEqual(state.document, nextDocument)) return [];
          return [
            {
              scope: {
                actorUserId: request.actorUserId,
                workspaceId: request.workspaceId,
                workspaceOwnerUserId: request.workspaceOwnerUserId,
                projectId: request.projectId,
                clipId: state.clipId,
              },
              expectedRevision: state.revision,
              nextDocument,
              captureOriginal: state.original ? null : state.document,
              retirePreview: false,
              retireEvidence: false,
              scores: state.scores,
              cleanupIntents: cleanupIntents(state, false),
            },
          ];
        });
        const committed = await input.store.commitProjectSelection({
          scope: request,
          expectedRevisions: states.map((state) => ({
            clipId: state.clipId,
            revision: state.revision,
          })),
          documents,
        });
        if (committed) {
          const commitsByClipId = new Map(
            documents.map((document) => [document.scope.clipId, document]),
          );
          for (const state of states) {
            const document = commitsByClipId.get(state.clipId);
            safeRecord(input.diagnostics, {
              actorUserId: request.actorUserId,
              projectId: request.projectId,
              clipId: state.clipId,
              mutationKind,
              attempt: attempt + 1,
              baseRevision: null,
              resultingRevision: state.revision + (document ? 1 : 0),
              noop: !document,
              invalidationClasses: document ? ["mutable_renders"] : [],
              cleanupCount: document?.cleanupIntents.length ?? 0,
              outcome: "accepted",
              elapsedMs: now().getTime() - startedAt,
            });
          }
          return { updated: documents.length };
        }
      }
      for (const state of lastStates) {
        safeRecord(input.diagnostics, {
          actorUserId: request.actorUserId,
          projectId: request.projectId,
          clipId: state.clipId,
          mutationKind,
          attempt: fieldRetryLimit,
          baseRevision: null,
          resultingRevision: state.revision,
          noop: false,
          invalidationClasses: [],
          cleanupCount: 0,
          outcome: "conflict",
          elapsedMs: now().getTime() - startedAt,
        });
      }
      persistenceError(
        "retryable_contention",
        "Clip Editor Documents changed repeatedly; retry the project mutation",
      );
    },
  };
}

export function createInMemoryClipEditorDocumentStore(
  seeds: ClipEditorDocumentStoredState[],
): ClipEditorDocumentStore & {
  inspect(clipId: string): {
    state: ClipEditorDocumentStoredState;
    cleanupObligations: Array<MediaCleanupObligationInput & { id: string }>;
    writeCount: number;
  } | null;
  forceContention(count: number): void;
} {
  const records = new Map(
    seeds.map((seed) => [
      seed.clipId,
      {
        state: clone(seed),
        cleanupObligations: [] as Array<MediaCleanupObligationInput & { id: string }>,
        writeCount: 0,
      },
    ]),
  );
  const projectScopes = new Map(
    seeds.map((seed) => [
      seed.projectId,
      {
        workspaceId: seed.workspaceId,
        workspaceOwnerUserId: seed.workspaceOwnerUserId,
      },
    ]),
  );
  let forcedContention = 0;

  const projectMatchesScope = (scope: ClipEditorProjectSelectionScope) => {
    const projectScope = projectScopes.get(scope.projectId);
    return Boolean(
      projectScope &&
        projectScope.workspaceId === scope.workspaceId &&
        projectScope.workspaceOwnerUserId === scope.workspaceOwnerUserId,
    );
  };

  const selectedRecords = (scope: ClipEditorProjectSelectionScope) =>
    [...records.values()]
      .filter(
        (record) =>
          record.state.projectId === scope.projectId &&
          record.state.workspaceId === scope.workspaceId &&
          record.state.workspaceOwnerUserId === scope.workspaceOwnerUserId &&
          record.state.clipId !== scope.excludeClipId,
      )
      .sort((left, right) => left.state.clipId.localeCompare(right.state.clipId));

  const applyCommit = (input: ClipEditorDocumentCommit) => {
    const record = records.get(input.scope.clipId)!;
    record.state.document = clone(input.nextDocument);
    record.state.revision += 1;
    record.state.status = "edited";
    if (!record.state.original && input.captureOriginal) {
      record.state.original = clone(input.captureOriginal);
    }
    record.state.mutableRenders = [];
    record.state.scores = clone(input.scores);
    if (input.retirePreview) {
      record.state.preview = { storageKey: null, startSec: null, durationSec: null };
    }
    if (input.retireEvidence) {
      record.state.evidence = { screen: null, automatic: null, split: null };
    }
    for (const intent of input.cleanupIntents) {
      if (
        !record.cleanupObligations.some(
          (existing) => existing.objectKey === intent.objectKey,
        )
      ) {
        record.cleanupObligations.push({ id: randomUUID(), ...clone(intent) });
      }
    }
    record.writeCount += 1;
  };

  return {
    async read(scope) {
      const record = records.get(scope.clipId);
      if (
        !record ||
        record.state.projectId !== scope.projectId ||
        record.state.workspaceId !== scope.workspaceId ||
        record.state.workspaceOwnerUserId !== scope.workspaceOwnerUserId
      ) {
        return null;
      }
      return clone(record.state);
    },
    async confirmRevision(scope, expectedRevision) {
      const record = records.get(scope.clipId);
      return Boolean(
        record &&
          record.state.projectId === scope.projectId &&
          record.state.workspaceId === scope.workspaceId &&
          record.state.workspaceOwnerUserId === scope.workspaceOwnerUserId &&
          record.state.revision === expectedRevision,
      );
    },
    async commit(input) {
      const record = records.get(input.scope.clipId);
      if (!record || record.state.revision !== input.expectedRevision) return null;
      if (forcedContention > 0) {
        forcedContention -= 1;
        return null;
      }
      applyCommit(input);
      return clone(record.state);
    },
    async readProjectSelection(scope) {
      if (!projectMatchesScope(scope)) return null;
      return selectedRecords(scope).map((record) => clone(record.state));
    },
    async commitProjectSelection(input) {
      if (!projectMatchesScope(input.scope)) return false;
      const selected = selectedRecords(input.scope);
      const expected = [...input.expectedRevisions].sort((left, right) =>
        left.clipId.localeCompare(right.clipId),
      );
      if (
        selected.length !== expected.length ||
        selected.some(
          (record, index) =>
            record.state.clipId !== expected[index]?.clipId ||
            record.state.revision !== expected[index]?.revision,
        ) ||
        input.documents.some(
          (documentCommit) =>
            records.get(documentCommit.scope.clipId)?.state.revision !==
            documentCommit.expectedRevision,
        )
      ) {
        return false;
      }
      if (forcedContention > 0) {
        forcedContention -= 1;
        return false;
      }
      for (const documentCommit of input.documents) applyCommit(documentCommit);
      return true;
    },
    inspect(clipId) {
      const record = records.get(clipId);
      return record ? clone(record) : null;
    },
    forceContention(count) {
      forcedContention = count;
    },
  };
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    persistenceError("persistence_unavailable", "Database client unavailable");
  }
  return prisma;
}

type PrismaNestedJsonValue = Prisma.InputJsonValue | null;

function toPrismaNestedJson(value: unknown): PrismaNestedJsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(toPrismaNestedJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toPrismaNestedJson(entry)]),
    );
  }
  throw new TypeError("Clip Editor Document JSON cannot contain undefined");
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  const encoded = toPrismaNestedJson(value);
  if (encoded === null) {
    throw new TypeError("Clip Editor Document JSON cannot be top-level null");
  }
  return encoded;
}

export function encodeClipEditorDocumentForStorage(
	value: EditorDocument,
	sourceDurationSec: number | null,
): {
  startSec: number;
  endSec: number;
  captionPreset: Prisma.InputJsonValue;
  transcriptSlice: Prisma.InputJsonValue;
  studioEdits: Prisma.InputJsonValue;
  brollUrl: string | null;
  deletedRanges: Prisma.InputJsonValue;
  editorDocumentVersion: number;
  sceneBlocks: Prisma.InputJsonValue;
  censorSegments: Prisma.InputJsonValue;
  mediaMotions: Prisma.InputJsonValue;
} {
  const document = canonicalizeDocument(value, sourceDurationSec);
  return {
    startSec: document.clipStartSec,
    endSec: document.clipEndSec,
    captionPreset: toPrismaJson(document.captionPreset),
    transcriptSlice: toPrismaJson(document.transcriptSlice),
    studioEdits: toPrismaJson(document.studioEdits),
    brollUrl: document.brollUrl,
    deletedRanges: toPrismaJson(document.deletedRanges),
    editorDocumentVersion: document.version,
    sceneBlocks: toPrismaJson(document.sceneBlocks),
    censorSegments: toPrismaJson(document.censorSegments),
    mediaMotions: toPrismaJson(document.mediaMotions),
  };
}

type PrismaStoredClip = Awaited<
  ReturnType<ReturnType<typeof requirePrisma>["clip"]["findFirst"]>
>;

function decodeStoredDocument(row: unknown): EditorDocument {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    persistenceError("corrupt_stored_document", "Stored Clip Editor Document is malformed");
  }
  const startSec = Reflect.get(row, "startSec");
  const endSec = Reflect.get(row, "endSec");
  const captionPreset = Reflect.get(row, "captionPreset");
  const transcriptSlice = Reflect.get(row, "transcriptSlice");
  const studioEdits = Reflect.get(row, "studioEdits");
  const brollUrl = Reflect.get(row, "brollUrl");
  const deletedRanges = Reflect.get(row, "deletedRanges");
  const editorDocumentVersion = Reflect.get(row, "editorDocumentVersion");
  const sceneBlocks = Reflect.get(row, "sceneBlocks");
  const censorSegments = Reflect.get(row, "censorSegments");
  const mediaMotions = Reflect.get(row, "mediaMotions");
  if (editorDocumentVersion !== 2) {
    persistenceError("unsupported_editor_document_version", "Stored Clip Editor Document uses an unsupported version");
  }
  if (
    typeof startSec !== "number" ||
    typeof endSec !== "number" ||
    (brollUrl !== null && typeof brollUrl !== "string")
  ) {
    persistenceError("corrupt_stored_document", "Stored Clip Editor Document is malformed");
  }
  const transcript = updateClipTranscriptSliceSchema.safeParse({
    transcriptSlice,
  });
  const caption =
    captionPreset === null
      ? { success: true as const, data: DEFAULT_CAPTION_PRESET }
      : captionPresetSchema.safeParse(captionPreset);
  const studio =
    studioEdits === null
      ? studioEditsSchema.safeParse(undefined)
      : studioEditsSchema.safeParse(studioEdits);
  const ranges =
    deletedRanges === null
      ? { success: true as const, data: [] }
      : deletedRangesSchema.safeParse(deletedRanges);
  if (!transcript.success || !caption.success || !studio.success || !ranges.success) {
    persistenceError("corrupt_stored_document", "Stored Clip Editor Document is malformed");
  }
  const decoded = editorDocumentSchema.safeParse({
    version: 2,
    sceneBlocks,
    censorSegments,
    mediaMotions,
    clipStartSec: startSec,
    clipEndSec: endSec,
    captionPreset: caption.data,
    transcriptSlice: transcript.data.transcriptSlice,
    studioEdits: studio.data,
    brollUrl,
    deletedRanges: ranges.data,
  });
  if (!decoded.success) {
    persistenceError("corrupt_stored_document", "Stored Clip Editor Document is malformed");
  }
  return decoded.data;
}

export function decodeClipEditorDocumentFromStorage(
  row: unknown,
  sourceDurationSec: number | null,
): EditorDocument {
  return canonicalizeDocument(decodeStoredDocument(row), sourceDurationSec);
}

function decodePrismaState(
  row: NonNullable<PrismaStoredClip> & {
    project: {
      userId: string;
      workspaceId: string;
      sourceDurationSeconds: number | null;
      sourceStorageKey: string | null;
      transcript: { utterancesJson: Prisma.JsonValue } | null;
    };
    renders: Array<{ id: string; storageKey: string | null }>;
  },
): ClipEditorDocumentStoredState {
  const document = decodeClipEditorDocumentFromStorage(
    row,
    row.project.sourceDurationSeconds,
  );
  const original =
    row.editorOriginal === null
      ? null
      : editorDocumentSchema.safeParse(row.editorOriginal);
  if (original && !original.success) {
    persistenceError("corrupt_stored_document", "Stored original Clip Editor Document is malformed");
  }
  const sourceTranscript = row.project.transcript
    ? updateClipTranscriptSliceSchema.safeParse({
        transcriptSlice: row.project.transcript.utterancesJson,
      })
    : null;
  if (sourceTranscript && !sourceTranscript.success) {
    persistenceError("corrupt_stored_document", "Stored source transcript is malformed");
  }
  return {
    workspaceId: row.project.workspaceId,
    workspaceOwnerUserId: row.project.userId,
    projectId: row.projectId,
    clipId: row.id,
    revision: row.editorRevision,
    document,
    original: original?.data ?? null,
    sourceDurationSec: row.project.sourceDurationSeconds,
    sourceStorageKey: row.project.sourceStorageKey,
    sourceTranscript: sourceTranscript?.data.transcriptSlice ?? [],
    viralityScore: row.viralityScore,
    status: row.status,
    preview: {
      storageKey: row.previewStorageKey,
      startSec: row.previewStartSec,
      durationSec: row.previewDurationSec,
    },
    evidence: {
      screen: row.layoutAnalysis,
      automatic: row.autoLayoutAnalysis,
      split: row.splitLayoutAnalysis,
    },
    scores: {
      durationOptimality: row.durationOptimalityScore,
      tiktok: row.tiktokScore,
      youtube: row.youtubeScore,
      instagram: row.instagramScore,
    },
    mutableRenders: row.renders,
  };
}

const prismaClipInclude = {
  project: {
    select: {
      userId: true,
      workspaceId: true,
      sourceDurationSeconds: true,
      sourceStorageKey: true,
      transcript: { select: { utterancesJson: true } },
    },
  },
  renders: {
    where: { exportVariantId: null },
    select: { id: true, storageKey: true },
  },
} as const;

function prismaDocumentUpdateData(
  input: ClipEditorDocumentCommit,
): Prisma.ClipUpdateManyMutationInput {
  return {
    startSec: input.nextDocument.clipStartSec,
    endSec: input.nextDocument.clipEndSec,
    captionPreset: toPrismaJson(input.nextDocument.captionPreset),
    transcriptSlice: toPrismaJson(input.nextDocument.transcriptSlice),
    studioEdits: toPrismaJson(input.nextDocument.studioEdits),
    brollUrl: input.nextDocument.brollUrl,
    deletedRanges: toPrismaJson(input.nextDocument.deletedRanges),
    editorDocumentVersion: input.nextDocument.version,
    sceneBlocks: toPrismaJson(input.nextDocument.sceneBlocks),
    censorSegments: toPrismaJson(input.nextDocument.censorSegments),
    mediaMotions: toPrismaJson(input.nextDocument.mediaMotions),
    editorRevision: { increment: 1 },
    status: "edited",
    durationOptimalityScore: input.scores.durationOptimality,
    tiktokScore: input.scores.tiktok,
    youtubeScore: input.scores.youtube,
    instagramScore: input.scores.instagram,
    ...(input.captureOriginal
      ? { editorOriginal: toPrismaJson(input.captureOriginal) }
      : {}),
    ...(input.retirePreview
      ? {
          previewStorageKey: null,
          previewStartSec: null,
          previewDurationSec: null,
        }
      : {}),
    ...(input.retireEvidence
      ? {
          layoutAnalysis: Prisma.DbNull,
          autoLayoutAnalysis: Prisma.DbNull,
          splitLayoutAnalysis: Prisma.DbNull,
          autoLayoutStatus: "pending" as const,
          autoLayoutClaimToken: null,
          autoLayoutLeaseExpiresAt: null,
        }
      : {}),
  };
}

class ProjectSelectionRevisionChanged extends Error {}

function prismaProjectAccessWhere(scope: ClipEditorDocumentActorScope) {
  return {
    workspaceId: scope.workspaceId,
    userId: scope.workspaceOwnerUserId,
    ...accessibleProjectWhere(),
  } satisfies Prisma.ProjectWhereInput;
}

export const prismaClipEditorDocumentStore: ClipEditorDocumentStore = {
  async read(scope) {
    const row = await requirePrisma().clip.findFirst({
      where: {
        id: scope.clipId,
        projectId: scope.projectId,
        project: prismaProjectAccessWhere(scope),
      },
      include: prismaClipInclude,
    });
    return row ? decodePrismaState(row) : null;
  },

  async confirmRevision(scope, expectedRevision) {
    const count = await requirePrisma().clip.count({
      where: {
        id: scope.clipId,
        projectId: scope.projectId,
        editorRevision: expectedRevision,
        project: prismaProjectAccessWhere(scope),
      },
    });
    return count === 1;
  },

  async commit(input) {
    const prisma = requirePrisma();
    return prisma.$transaction(async (tx) => {
      const guarded = await tx.clip.updateMany({
        where: {
          id: input.scope.clipId,
          projectId: input.scope.projectId,
          editorRevision: input.expectedRevision,
          project: prismaProjectAccessWhere(input.scope),
        },
        data: prismaDocumentUpdateData(input),
      });
      if (guarded.count !== 1) return null;

      await tx.clipRender.deleteMany({
        where: { clipId: input.scope.clipId, exportVariantId: null },
      });
      if (input.cleanupIntents.length > 0) {
        await admitMediaCleanupObligations(
          tx.mediaCleanupObligation,
          input.cleanupIntents,
        );
      }
      const row = await tx.clip.findUniqueOrThrow({
        where: { id: input.scope.clipId },
        include: prismaClipInclude,
      });
      return decodePrismaState(row);
    }, { isolationLevel: "ReadCommitted", timeout: 30_000, maxWait: 10_000 });
  },

  async readProjectSelection(scope) {
    const project = await requirePrisma().project.findFirst({
      where: { id: scope.projectId, ...prismaProjectAccessWhere(scope) },
      select: {
        userId: true,
        workspaceId: true,
        sourceDurationSeconds: true,
        sourceStorageKey: true,
        transcript: { select: { utterancesJson: true } },
        clips: {
          where: scope.excludeClipId ? { id: { not: scope.excludeClipId } } : {},
          orderBy: { id: "asc" },
          include: { renders: prismaClipInclude.renders },
        },
      },
    });
    if (!project) return null;
    return project.clips.map((row) =>
      decodePrismaState({
        ...row,
        project: {
          userId: project.userId,
          workspaceId: project.workspaceId,
          sourceDurationSeconds: project.sourceDurationSeconds,
          sourceStorageKey: project.sourceStorageKey,
          transcript: project.transcript,
        },
      }),
    );
  },

  async commitProjectSelection(input) {
    const prisma = requirePrisma();
    try {
      await prisma.$transaction(
        async (tx) => {
          const projectCount = await tx.project.count({
            where: {
              id: input.scope.projectId,
              ...prismaProjectAccessWhere(input.scope),
            },
          });
          if (projectCount !== 1) throw new ProjectSelectionRevisionChanged();

          const excludeClause = input.scope.excludeClipId
            ? Prisma.sql`AND "id" <> ${input.scope.excludeClipId}::uuid`
            : Prisma.empty;
          const locked = await tx.$queryRaw<
            Array<{ id: string; editorRevision: number }>
          >(Prisma.sql`
            SELECT "id", "editorRevision"
            FROM "Clip"
            WHERE "projectId" = ${input.scope.projectId}::uuid
            ${excludeClause}
            ORDER BY "id"
            FOR UPDATE
          `);
          const expected = [...input.expectedRevisions].sort((left, right) =>
            left.clipId.localeCompare(right.clipId),
          );
          if (
            locked.length !== expected.length ||
            locked.some(
              (row, index) =>
                row.id !== expected[index]?.clipId ||
                row.editorRevision !== expected[index]?.revision,
            )
          ) {
            throw new ProjectSelectionRevisionChanged();
          }

          const documents = [...input.documents].sort((left, right) =>
            left.scope.clipId.localeCompare(right.scope.clipId),
          );
          if (documents.length === 0) return;
          const clipIds = documents.map((document) => document.scope.clipId);
          await tx.clipRender.deleteMany({
            where: { clipId: { in: clipIds }, exportVariantId: null },
          });
          for (const document of documents) {
            await tx.clip.update({
              where: { id: document.scope.clipId },
              data: prismaDocumentUpdateData(document),
            });
          }
          const cleanup = documents.flatMap((document) => document.cleanupIntents);
          if (cleanup.length > 0) {
            await admitMediaCleanupObligations(tx.mediaCleanupObligation, cleanup);
          }
        },
        { isolationLevel: "Serializable", timeout: 30_000, maxWait: 10_000 },
      );
      return true;
    } catch (error) {
      if (
        error instanceof ProjectSelectionRevisionChanged ||
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")
      ) {
        return false;
      }
      throw error;
    }
  },
};

const structuredDiagnostics: ClipEditorDocumentDiagnostics = {
  record(event) {
    console.warn(
      JSON.stringify({
        level: event.outcome === "accepted" ? "info" : "warn",
        message: "clip_editor_document_mutation",
        ...event,
      }),
    );
  },
};

export const clipEditorDocumentPersistence = createClipEditorDocumentPersistence({
  store: prismaClipEditorDocumentStore,
  diagnostics: structuredDiagnostics,
});
