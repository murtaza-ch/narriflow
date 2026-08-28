import { describe, expect, test } from "bun:test";
import { ClipEditorDocumentPersistenceError } from "@narriflow/services";
import { clipEditorPersistenceHttpError } from "./editor-persistence-http";

describe("Clip Editor Document Persistence HTTP mapping", () => {
  test.each([
    ["clip_not_found", 404, "clip_not_found", false],
    ["corrupt_stored_document", 409, "editor_document_corrupt", false],
    ["retryable_contention", 409, "retryable_contention", true],
    ["editor_boundaries_invalid", 422, "editor_boundaries_invalid", false],
    ["editor_document_empty_timeline", 422, "editor_document_empty_timeline", false],
    ["persistence_unavailable", 503, "persistence_unavailable", true],
  ] as const)("maps %s to its stable transport contract", (code, status, responseCode, retryable) => {
    const mapped = clipEditorPersistenceHttpError(
      new ClipEditorDocumentPersistenceError(code, "safe message"),
    );
    expect(mapped).toMatchObject({ status, body: { error: responseCode } });
    expect(mapped && "retryable" in mapped.body ? mapped.body.retryable : false).toBe(
      retryable,
    );
  });

  test("ignores errors owned by another HTTP surface", () => {
    expect(clipEditorPersistenceHttpError(new Error("other"))).toBeNull();
  });
});
