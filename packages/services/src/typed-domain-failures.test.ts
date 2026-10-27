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
import { ProcessingUsageError } from "./processing-usage";
import {
	ProjectNotFoundError,
	ProjectServiceError,
} from "./project.service";
import { ReviewServiceError } from "./review.service";
import { SocialServiceError } from "./social.service";
import { requirePlanFeature } from "./plan-features";

function requirePlanFailure(tier: string, feature: Parameters<typeof requirePlanFeature>[1]) {
	try {
		requirePlanFeature(tier, feature);
	} catch (error) {
		return error as Error & { kind: string };
	}
	throw new Error("expected a plan refusal");
}

describe("typed domain failure catalogs", () => {
  test.each([
    [new AudioAssetNotFoundError(), "missing"],
    [new BrandTemplateForbiddenError(), "forbidden"],
    [new ReviewServiceError("review_access_invalid", "Invalid review access"), "invalid"],
    [new ReviewServiceError("review_round_closed", "Review round closed"), "conflict"],
    [new ClipEditorDocumentPersistenceError("editor_document_invalid", "Invalid editor document"), "unprocessable"],
    [new GeneratedMediaJobError("generated_media_concurrency_limit_reached"), "rate_limited"],
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
		[requirePlanFailure("free", "integrations.api"), "payment_required"],
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
      new ProcessingUsageError({
        code: "credits_exhausted",
        message: "Monthly credits used",
        details: {
          tier: "creator",
          limitCredits: 300,
          remainingCredits: 1,
          spentCredits: 299,
          requestedCredits: 2,
          renewsAt: "2026-11-01T00:00:00.000Z",
        },
      }),
    ).toMatchObject({
      code: "credits_exhausted",
      kind: "payment_required",
      details: { requestedCredits: 2 },
    });
    expect(
      new ProcessingUsageError({
        code: "workspace_processing_capacity_reached",
        message: "Capacity reached",
        details: { tier: "free", inFlight: 2, inFlightLimit: 2 },
        retryAfterSeconds: 60,
      }),
    ).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 60 });
    expect(
      new ProcessingUsageError({
        code: "credits_reservation_released",
        message: "Retry the import",
        details: { tier: "free" },
      }),
    ).toMatchObject({ kind: "conflict" });
  });
});
