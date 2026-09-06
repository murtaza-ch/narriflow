import { describe, expect, test } from "bun:test";
import { AudioAssetNotFoundError } from "./audio-asset.service";
import { BrandTemplateForbiddenError } from "./brand-template.service";
import {
  ClipEditorDocumentPersistenceError,
  ClipEditorRevisionConflictError,
} from "./clip-editor-document-persistence";
import { ContentSuiteError } from "./content-suite.service";
import { GeneratedMediaJobError } from "./generated-media";
import { QuotaExceededError } from "./project.service";
import { ReviewServiceError } from "./review.service";

describe("typed domain failure catalogs", () => {
  test.each([
    [new AudioAssetNotFoundError(), "missing"],
    [new BrandTemplateForbiddenError(), "forbidden"],
    [new ReviewServiceError("review_access_invalid", "Invalid review access"), "invalid"],
    [new ReviewServiceError("review_round_closed", "Review round closed"), "conflict"],
    [new ClipEditorDocumentPersistenceError("editor_document_invalid", "Invalid editor document"), "unprocessable"],
    [new GeneratedMediaJobError("generated_media_daily_limit_reached"), "rate_limited"],
    [new ContentSuiteError("database_unavailable", "Content is temporarily unavailable"), "unavailable"],
  ] as const)("owns the %s semantic kind", (failure, kind) => {
    expect(failure.kind).toBe(kind);
  });

  test("keeps revision and quota metadata under bounded details", () => {
    expect(new ClipEditorRevisionConflictError(8)).toMatchObject({
      code: "editor_revision_conflict",
      kind: "conflict",
      details: { currentRevision: 8 },
    });
    expect(
      new QuotaExceededError("Monthly processing limit reached", {
        tier: "creator",
        limitMinutes: 600,
        usedMinutes: 599,
        requestedMinutes: 2,
      }),
    ).toMatchObject({
      code: "quota_exceeded",
      kind: "payment_required",
      details: { requestedMinutes: 2 },
    });
  });
});
