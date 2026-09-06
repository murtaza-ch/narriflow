import { describe, expect, test } from "bun:test";
import { AudioAssetNotFoundError } from "./audio-asset.service";
import { AutopilotError } from "./autopilot.service";
import { BrandTemplateForbiddenError } from "./brand-template.service";
import {
  ClipEditorDocumentPersistenceError,
  ClipEditorRevisionConflictError,
} from "./clip-editor-document-persistence";
import { ContentSuiteError } from "./content-suite.service";
import { DubbingFailureError } from "./dubbing.service";
import { GeneratedMediaJobError } from "./generated-media";
import {
	ProjectNotFoundError,
	ProjectServiceError,
	QuotaExceededError,
} from "./project.service";
import { ReviewServiceError } from "./review.service";
import { SocialServiceError } from "./social.service";
import { WorkspaceOperationError } from "./workspace.service";

describe("typed domain failure catalogs", () => {
  test.each([
    [new AudioAssetNotFoundError(), "missing"],
    [new BrandTemplateForbiddenError(), "forbidden"],
    [new ReviewServiceError("review_access_invalid", "Invalid review access"), "invalid"],
    [new ReviewServiceError("review_round_closed", "Review round closed"), "conflict"],
    [new ClipEditorDocumentPersistenceError("editor_document_invalid", "Invalid editor document"), "unprocessable"],
    [new GeneratedMediaJobError("generated_media_daily_limit_reached"), "rate_limited"],
    [new ContentSuiteError("database_unavailable"), "unavailable"],
		[new AutopilotError("autopilot_rule_not_found"), "missing"],
		[new AutopilotError("autopilot_rule_limit_reached"), "conflict"],
		[new SocialServiceError("social_post_not_found"), "missing"],
		[new ProjectNotFoundError(), "missing"],
		[
			new ProjectServiceError(
				"project_ingest_not_ready",
				"Project ingest is not ready.",
			),
			"conflict",
		],
		[new DubbingFailureError("dub_not_found", "Dub not found."), "missing"],
		[
			new WorkspaceOperationError(
				"workspace_api_requires_business",
				"Workspace API keys require Business",
			),
			"payment_required",
		],
  ] as const)("owns the %s semantic kind", (failure, kind) => {
    expect(failure.kind).toBe(kind);
  });

  test("keeps revision and quota metadata under bounded details", () => {
    const revisionFailure = new ClipEditorRevisionConflictError(8);
		expect(revisionFailure).toMatchObject({
      code: "editor_revision_conflict",
      kind: "conflict",
      details: { currentRevision: 8 },
    });
		expect("currentRevision" in revisionFailure).toBe(false);
		const persistenceFailure = new ClipEditorDocumentPersistenceError(
			"retryable_contention",
			"Try again",
		);
		expect(persistenceFailure.details).toEqual({ retryable: true });
		expect("retryable" in persistenceFailure).toBe(false);
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
