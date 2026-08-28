import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  CLIP_MAX_DURATION_SEC,
  CLIP_MIN_DURATION_SEC,
  DEFAULT_CAPTION_PRESET,
  captionPresetSchema,
  deletedRangesSchema,
  editorDocumentSchema,
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
  type ClipStatus,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { assertPublicHttpUrl, UnsafeUrlError } from "./url-guard";
import { tryDerivePeaksStorageKey } from "./clip-preview-storage";
import { computeDurationOptimality, computePlatformScore } from "./clip-scoring";

export class ClipEditorRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("editor document revision conflict");
    this.name = "ClipEditorRevisionConflictError";
  }
}

export type ClipEditorDocumentPersistenceErrorCode =
  | "clip_not_found"
  | "corrupt_stored_document"
  | "editor_boundaries_invalid"
  | "editor_document_empty_timeline"
  | "retryable_contention"
  | "persistence_unavailable"
  | "project_selection_not_implemented";

export class ClipEditorDocumentPersistenceError extends Error {
  constructor(
    readonly code: ClipEditorDocumentPersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClipEditorDocumentPersistenceError";
  }
}

export type EditorMediaCleanupClass =
  | "mutable_render"
  | "preview_proxy"
  | "preview_peaks";

export interface EditorMediaCleanupIntent {
  cleanupClass: EditorMediaCleanupClass;
  objectKey: string;
}

export interface ClipEditorDocumentStoredState {
  actorUserId: string;
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

export interface ClipEditorDocumentScope {
  actorUserId: string;
  projectId: string;
  clipId: string;
}

export type ClipEditorDocumentMutationIntent =
  | { kind: "replace"; baseRevision: number; document: EditorDocument }
  | { kind: "reset"; baseRevision: number }
  | { kind: "set_boundaries"; startSec: number; endSec: number }
  | { kind: "set_transcript"; transcriptSlice: TranscriptUtterance[] };

export type ClipEditorProjectSelectionIntent =
  | { kind: "set_caption_preset"; captionPreset: EditorDocument["captionPreset"] }
  | {
      kind: "patch_studio_edits";
      patches: ReadonlyArray<Partial<EditorDocument["studioEdits"]>>;
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
  cleanupIntents: EditorMediaCleanupIntent[];
}

export interface ClipEditorDocumentStore {
  read(scope: ClipEditorDocumentScope): Promise<ClipEditorDocumentStoredState | null>;
  confirmRevision(scope: ClipEditorDocumentScope, expectedRevision: number): Promise<boolean>;
  commit(input: ClipEditorDocumentCommit): Promise<ClipEditorDocumentStoredState | null>;
}

export interface ClipEditorDocumentDiagnostics {
  record(event: {
    projectId: string;
    clipId: string;
    mutationKind: ClipEditorDocumentMutationIntent["kind"];
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

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function editorDocumentsEqual(
  left: EditorDocument,
  right: EditorDocument,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
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
): EditorMediaCleanupIntent[] {
  const intents: EditorMediaCleanupIntent[] = state.mutableRenders.flatMap((render) =>
    render.storageKey
      ? [{ cleanupClass: "mutable_render" as const, objectKey: render.storageKey }]
      : [],
  );
  if (retirePreview && state.preview.storageKey) {
    intents.push({ cleanupClass: "preview_proxy", objectKey: state.preview.storageKey });
    const peaksKey = tryDerivePeaksStorageKey(state.preview.storageKey);
    if (peaksKey) intents.push({ cleanupClass: "preview_peaks", objectKey: peaksKey });
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
    try {
      return {
        ...state,
        document: canonicalizeDocument(state.document, state.sourceDurationSec),
        original: state.original !== null
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
        "projectId" | "clipId" | "mutationKind" | "baseRevision" | "elapsedMs"
      >,
    ) =>
      safeRecord(input.diagnostics, {
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
        canonicalJson(state.document.deletedRanges) !== canonicalJson(next.deletedRanges);
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
    async mutateProjectSelection(_request: {
      actorUserId: string;
      projectId: string;
      excludeClipId?: string;
      intent: ClipEditorProjectSelectionIntent;
    }): Promise<{ updated: number }> {
      persistenceError(
        "project_selection_not_implemented",
        "Project-selection production adapters arrive with the presentation-mutation ticket",
      );
    },
  };
}

export function createInMemoryClipEditorDocumentStore(
  seeds: ClipEditorDocumentStoredState[],
): ClipEditorDocumentStore & {
  inspect(clipId: string): {
    state: ClipEditorDocumentStoredState;
    cleanupObligations: Array<EditorMediaCleanupIntent & { id: string }>;
    writeCount: number;
  } | null;
  forceContention(count: number): void;
} {
  const records = new Map(
    seeds.map((seed) => [
      seed.clipId,
      {
        state: clone(seed),
        cleanupObligations: [] as Array<EditorMediaCleanupIntent & { id: string }>,
        writeCount: 0,
      },
    ]),
  );
  let forcedContention = 0;

  return {
    async read(scope) {
      const record = records.get(scope.clipId);
      if (
        !record ||
        record.state.projectId !== scope.projectId ||
        record.state.actorUserId !== scope.actorUserId
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
          record.state.actorUserId === scope.actorUserId &&
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
      return clone(record.state);
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
  value: unknown,
  sourceDurationSec: number | null,
): {
  startSec: number;
  endSec: number;
  captionPreset: Prisma.InputJsonValue;
  transcriptSlice: Prisma.InputJsonValue;
  studioEdits: Prisma.InputJsonValue;
  brollUrl: string | null;
  deletedRanges: Prisma.InputJsonValue;
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
  };
}

type PrismaStoredClip = Awaited<
  ReturnType<ReturnType<typeof requirePrisma>["clip"]["findFirst"]>
>;

function decodeStoredDocument(row: {
  startSec: number;
  endSec: number;
  captionPreset: unknown;
  transcriptSlice: unknown;
  studioEdits: unknown;
  brollUrl: string | null;
  deletedRanges: unknown;
}): EditorDocument {
  const transcript = updateClipTranscriptSliceSchema.safeParse({
    transcriptSlice: row.transcriptSlice,
  });
  const caption =
    row.captionPreset === null
      ? { success: true as const, data: DEFAULT_CAPTION_PRESET }
      : captionPresetSchema.safeParse(row.captionPreset);
  const studio =
    row.studioEdits === null
      ? studioEditsSchema.safeParse(undefined)
      : studioEditsSchema.safeParse(row.studioEdits);
  const ranges =
    row.deletedRanges === null
      ? { success: true as const, data: [] }
      : deletedRangesSchema.safeParse(row.deletedRanges);
  if (!transcript.success || !caption.success || !studio.success || !ranges.success) {
    persistenceError("corrupt_stored_document", "Stored Clip Editor Document is malformed");
  }
  const decoded = editorDocumentSchema.safeParse({
    clipStartSec: row.startSec,
    clipEndSec: row.endSec,
    captionPreset: caption.data,
    transcriptSlice: transcript.data.transcriptSlice,
    studioEdits: studio.data,
    brollUrl: row.brollUrl,
    deletedRanges: ranges.data,
  });
  if (!decoded.success) {
    persistenceError("corrupt_stored_document", "Stored Clip Editor Document is malformed");
  }
  return decoded.data;
}

function decodePrismaState(
  row: NonNullable<PrismaStoredClip> & {
    project: {
      userId: string;
      sourceDurationSeconds: number | null;
      sourceStorageKey: string | null;
      transcript: { utterancesJson: Prisma.JsonValue } | null;
    };
    renders: Array<{ id: string; storageKey: string | null }>;
  },
): ClipEditorDocumentStoredState {
  const document = decodeStoredDocument(row);
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
    actorUserId: row.project.userId,
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

export const prismaClipEditorDocumentStore: ClipEditorDocumentStore = {
  async read(scope) {
    const row = await requirePrisma().clip.findFirst({
      where: {
        id: scope.clipId,
        projectId: scope.projectId,
        project: { userId: scope.actorUserId },
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
        project: { userId: scope.actorUserId },
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
          project: { userId: input.scope.actorUserId },
        },
        data: {
          startSec: input.nextDocument.clipStartSec,
          endSec: input.nextDocument.clipEndSec,
          captionPreset: toPrismaJson(input.nextDocument.captionPreset),
          transcriptSlice: toPrismaJson(input.nextDocument.transcriptSlice),
          studioEdits: toPrismaJson(input.nextDocument.studioEdits),
          brollUrl: input.nextDocument.brollUrl,
          deletedRanges: toPrismaJson(input.nextDocument.deletedRanges),
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
        },
      });
      if (guarded.count !== 1) return null;

      await tx.clipRender.deleteMany({
        where: { clipId: input.scope.clipId, exportVariantId: null },
      });
      if (input.cleanupIntents.length > 0) {
        await tx.editorMediaCleanupObligation.createMany({
          data: input.cleanupIntents.map((intent) => ({
            projectId: input.scope.projectId,
            clipId: input.scope.clipId,
            cleanupClass: intent.cleanupClass,
            objectKey: intent.objectKey,
          })),
          skipDuplicates: true,
        });
      }
      const row = await tx.clip.findUniqueOrThrow({
        where: { id: input.scope.clipId },
        include: prismaClipInclude,
      });
      return decodePrismaState(row);
    }, { isolationLevel: "ReadCommitted", timeout: 30_000, maxWait: 10_000 });
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
