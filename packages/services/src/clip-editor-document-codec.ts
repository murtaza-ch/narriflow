import { clipDurationWithinBounds, DEFAULT_CAPTION_PRESET, EDITOR_DOCUMENT_VERSION, captionPresetSchema, deletedRangesSchema, editorDocumentSchema, hasRenderableContent, normalizeDeletedRanges, normalizeTranscriptSliceForClip, studioEditsSchema, updateClipTranscriptSliceSchema, type EditorDocument } from "@narriflow/validators";
import { assertPublicHttpUrl } from "./url-policy";
import { ExpectedDomainFailureError, type ExpectedDomainFailureCatalog } from "./expected-domain-failure";

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

export function persistenceError(
  code: ClipEditorDocumentPersistenceErrorCode,
  message: string,
): never {
  throw new ClipEditorDocumentPersistenceError(code, message);
}

/** What bounds a clip's window: the source's length, and the duration policy
 * its `wholeSource` flag selects (`clipDurationBounds`). */
export interface ClipSourceWindow {
  durationSec: number | null;
  wholeSource: boolean;
}

function assertDocumentWindow(
  document: EditorDocument,
  source: ClipSourceWindow,
): void {
  const durationSec = document.clipEndSec - document.clipStartSec;
  if (
    !clipDurationWithinBounds(durationSec, source.wholeSource) ||
    (source.durationSec !== null && document.clipEndSec > source.durationSec + 0.001)
  ) {
    persistenceError(
      "editor_boundaries_invalid",
      "clip boundaries are outside the renderable source window",
    );
  }
}

export function canonicalizeDocument(
  value: unknown,
  source: ClipSourceWindow,
): EditorDocument {
  const parsed = editorDocumentSchema.safeParse(value);
  if (!parsed.success) {
    persistenceError("corrupt_stored_document", "Clip Editor Document is malformed");
  }
  assertDocumentWindow(parsed.data, source);
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
  if (editorDocumentVersion !== EDITOR_DOCUMENT_VERSION) {
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
    version: EDITOR_DOCUMENT_VERSION,
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

/** A stored clip row. The caller states the clip's `wholeSource` flag, which
 * selects the duration policy, so a select that left it out can't quietly
 * apply the detected-clip bounds. */
export function decodeClipEditorDocumentFromStorage(
  row: unknown,
  source: ClipSourceWindow,
): EditorDocument {
  return canonicalizeDocument(decodeStoredDocument(row), source);
}

/** A frozen export snapshot, which always records its own `wholeSource` flag;
 * a snapshot without one is corrupt rather than a detected clip. */
export function decodeFrozenClipEditorDocument(
  snapshot: unknown,
  sourceDurationSec: number | null,
): EditorDocument {
  const wholeSource = (snapshot as { wholeSource?: unknown } | null)?.wholeSource;
  if (typeof wholeSource !== "boolean") {
    persistenceError("corrupt_stored_document", "Frozen clip snapshot has no wholeSource flag");
  }
  return decodeClipEditorDocumentFromStorage(snapshot, { durationSec: sourceDurationSec, wholeSource });
}

