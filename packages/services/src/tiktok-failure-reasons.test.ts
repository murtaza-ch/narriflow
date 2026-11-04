import { expect, test } from "bun:test";
import { tiktokFailureCode } from "./tiktok-failure-reasons";

test("every TikTok fail_reason maps to one code, whichever route reported it", () => {
	expect(tiktokFailureCode("spam_risk_text")).toBe("tiktok_spam_risk");
	expect(tiktokFailureCode("unaudited_client_can_only_post_to_private_accounts")).toBe("tiktok_audit_privacy_required");
	expect(tiktokFailureCode("spam_risk_too_many_posts")).toBe("tiktok_rate_limit");
	expect(tiktokFailureCode("something_new")).toBe("tiktok_publish_failed");
	expect(tiktokFailureCode(null)).toBe("tiktok_publish_failed");
});
