import { getPrismaClient } from "@narriflow/db/client";
import { SOCIAL_PROVIDER_CAPABILITIES } from "@narriflow/validators";
import { socialOAuthService } from "./social-oauth.service";
import { recordTikTokPublicationEvent } from "./social-publication-tiktok-webhook";
import { ExpectedDomainFailureError } from "./expected-domain-failure";

function unavailable(message: string) {
	return new ExpectedDomainFailureError({
		code: "social_account_unavailable",
		kind: "unavailable",
		message,
	});
}
async function tiktokRead(token: string, path: string, body: object = {}) {
	const response = await fetch(
		`https://open.tiktokapis.com/v2/post/publish/${path}/`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15000),
		},
	);
	const value = (await response.json()) as {
		data?: Record<string, unknown>;
		error?: { code?: string };
	};
	if (
		!response.ok ||
		(value.error?.code && value.error.code !== "ok") ||
		!value.data
	)
		throw unavailable(
			"TikTok account settings could not be loaded. Check the connection and try again.",
		);
	return value.data;
}
export async function socialPublishingOptions(
	workspaceId: string,
	accountId: string,
) {
	const row = await getPrismaClient()?.socialAccount.findFirst({
		where: { id: accountId, workspaceId },
	});
	if (!row || row.status !== "active")
		throw unavailable("Reconnect this account to publish.");
	const capability = SOCIAL_PROVIDER_CAPABILITIES[row.platform];
	const result = {
		platform: row.platform,
		capability,
		inboxEnabled:
			row.platform === "tiktok" && row.scopes.includes("video.upload"),
		directEnabled:
			row.platform !== "tiktok" || row.scopes.includes("video.publish"),
		privacyOptions: [] as string[],
		commentDisabled: false,
		duetDisabled: false,
		stitchDisabled: false,
		maximumDurationSec: Number(capability.durationSec.max),
	};
	if (row.platform !== "tiktok" || !result.directEnabled) return result;
	const account = await socialOAuthService.getPublishAccount(accountId);
	const creator = await tiktokRead(account.accessToken, "creator_info/query");
	return {
		...result,
		privacyOptions: Array.isArray(creator.privacy_level_options)
			? creator.privacy_level_options.filter(
					(v): v is string => typeof v === "string",
				)
			: [],
		commentDisabled: creator.comment_disabled === true,
		duetDisabled: creator.duet_disabled === true,
		stitchDisabled: creator.stitch_disabled === true,
		maximumDurationSec:
			typeof creator.max_video_post_duration_sec === "number"
				? creator.max_video_post_duration_sec
				: result.maximumDurationSec,
	};
}
export async function refreshTikTokInbox(
	workspaceId: string,
	projectId: string,
	postId: string,
) {
	const row = await getPrismaClient()?.socialPost.findFirst({
		where: {
			id: postId,
			projectId,
			workspaceId,
			deliveryMode: "tiktok_inbox",
			status: { in: ["inbox_delivered", "posted"] },
		},
		include: {
			publicationAttempts: {
				where: { phase: "succeeded" },
				orderBy: { attemptNumber: "desc" },
				take: 1,
				include: { receipt: true },
			},
		},
	});
	const receipt = row?.publicationAttempts[0]?.receipt;
	if (!row?.socialAccountId || !receipt)
		throw unavailable("This TikTok delivery cannot be refreshed.");
	const account = await socialOAuthService.getPublishAccount(
		row.socialAccountId,
	);
	const status = await tiktokRead(account.accessToken, "status/fetch", {
		publish_id: receipt.receiptId,
	});
	if (status.status === "PUBLISH_COMPLETE") {
		const ids =
			status.publicaly_available_post_id ?? status.publicly_available_post_id;
		const postIds = Array.isArray(ids)
			? ids
					.filter((v) => typeof v === "string" || typeof v === "number")
					.map(String)
			: [];
		await recordTikTokPublicationEvent({
			event: "post.publish.complete",
			publishId: receipt.receiptId,
			postId: null,
			reason: null,
			publishType: "INBOX_SHARE",
		});
		for (const id of postIds)
			await recordTikTokPublicationEvent({
				event: "post.publish.publicly_available",
				publishId: receipt.receiptId,
				postId: id,
				reason: null,
				publishType: "INBOX_SHARE",
			});
	}
	return { status: status.status };
}
