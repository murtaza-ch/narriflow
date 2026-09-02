export function reviewApprovalHttpStatus(
	code: string,
): 400 | 403 | 404 | 409 | null {
	switch (code) {
		case "review_override_reason_invalid":
			return 400;
		case "review_override_forbidden":
			return 403;
		case "review_export_not_found":
			return 404;
		case "review_approval_required":
		case "review_override_conflict":
			return 409;
		default:
			return null;
	}
}
