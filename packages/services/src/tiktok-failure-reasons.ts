/** TikTok's `fail_reason` values as the stable failure codes the product shows.
 * The status poll and the `post.publish.failed` webhook both read this map, so
 * a failure never reads differently by the route it arrived on. */
const TIKTOK_FAILURE_CODES: Readonly<Record<string, string>> = {
	spam_risk: "tiktok_spam_risk",
	spam_risk_text: "tiktok_spam_risk",
	spam_risk_too_many_posts: "tiktok_daily_post_limit",
	spam_risk_too_many_pending_share: "tiktok_pending_drafts_limit",
	spam_risk_user_banned_from_posting: "tiktok_account_restricted",
	unaudited_client_can_only_post_to_private_accounts:
		"tiktok_audit_privacy_required",
};

export function tiktokFailureCode(reason: string | null | undefined): string {
	return (reason ? TIKTOK_FAILURE_CODES[reason] : undefined) ?? "tiktok_publish_failed";
}
