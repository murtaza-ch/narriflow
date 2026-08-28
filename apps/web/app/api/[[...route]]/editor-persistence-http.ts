import { ClipEditorDocumentPersistenceError } from "@narriflow/services";

export function clipEditorPersistenceHttpError(error: unknown) {
  if (!(error instanceof ClipEditorDocumentPersistenceError)) return null;
  switch (error.code) {
    case "clip_not_found":
      return { status: 404 as const, body: { error: "clip_not_found" } };
    case "project_not_found":
      return { status: 404 as const, body: { error: "project_not_found" } };
    case "corrupt_stored_document":
      return { status: 409 as const, body: { error: "editor_document_corrupt" } };
    case "retryable_contention":
      return {
        status: 409 as const,
        body: { error: error.code, message: error.message, retryable: true },
      };
    case "editor_boundaries_invalid":
    case "editor_document_empty_timeline":
    case "editor_document_invalid":
      return { status: 422 as const, body: { error: error.code } };
    case "persistence_unavailable":
      return {
        status: 503 as const,
        body: { error: error.code, retryable: true },
      };
    default:
      return {
        status: 400 as const,
        body: { error: error.code, message: error.message },
      };
  }
}
