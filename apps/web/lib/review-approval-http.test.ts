import { describe, expect, test } from "bun:test";
import { reviewApprovalHttpStatus } from "./review-approval-http";

describe("review approval HTTP errors", () => {
	test("maps expected refusals without exposing internal gate failures", () => {
		expect(reviewApprovalHttpStatus("review_override_reason_invalid")).toBe(400);
		expect(reviewApprovalHttpStatus("review_override_forbidden")).toBe(403);
		expect(reviewApprovalHttpStatus("review_export_not_found")).toBe(404);
		expect(reviewApprovalHttpStatus("review_approval_required")).toBe(409);
		expect(reviewApprovalHttpStatus("review_override_conflict")).toBe(409);
		expect(reviewApprovalHttpStatus("review_override_audit_incomplete")).toBeNull();
		expect(reviewApprovalHttpStatus("review_approval_policy_invalid")).toBeNull();
	});
});
