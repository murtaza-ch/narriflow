import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { publicationOperationLookupHash } from "./social-publication-attempt";

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

export class TikTokPublicationWebhookError extends Error {
	constructor(
		readonly code:
			| "tiktok_webhook_signature_invalid"
			| "tiktok_webhook_signature_expired"
			| "tiktok_webhook_payload_invalid"
			| "tiktok_webhook_client_mismatch",
		message: string,
	) {
		super(message);
		this.name = "TikTokPublicationWebhookError";
	}
}

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

export function verifyTikTokWebhookSignature(input: {
	rawBody: string;
	signature: string | null;
	clientSecret: string;
	now: Date;
	maximumAgeSeconds?: number;
}) {
	const values = new Map(
		(input.signature ?? "").split(",").map((part) => {
			const separator = part.indexOf("=");
			return separator < 0
				? [part.trim(), ""]
				: [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
		}),
	);
	const timestamp = values.get("t");
	const signature = values.get("s");
	if (
		!timestamp ||
		!/^\d+$/.test(timestamp) ||
		!signature ||
		!/^[a-f0-9]{64}$/i.test(signature)
	) {
		throw new TikTokPublicationWebhookError(
			"tiktok_webhook_signature_invalid",
			"TikTok webhook signature is missing or malformed",
		);
	}
	const expected = createHmac("sha256", input.clientSecret)
		.update(`${timestamp}.${input.rawBody}`)
		.digest();
	const received = Buffer.from(signature, "hex");
	if (
		received.length !== expected.length ||
		!timingSafeEqual(received, expected)
	) {
		throw new TikTokPublicationWebhookError(
			"tiktok_webhook_signature_invalid",
			"TikTok webhook signature does not match",
		);
	}
	const age = Math.abs(
		Math.floor(input.now.getTime() / 1000) - Number(timestamp),
	);
	if (age > (input.maximumAgeSeconds ?? MAX_SIGNATURE_AGE_SECONDS)) {
		throw new TikTokPublicationWebhookError(
			"tiktok_webhook_signature_expired",
			"TikTok webhook signature is outside the replay window",
		);
	}
}

export type TikTokPublicationEvent = {
	event:
		| "post.publish.complete"
		| "post.publish.publicly_available"
		| "post.publish.failed"
		| "post.publish.inbox_delivered";
	publishId: string;
	postId: string | null;
	reason: string | null;
	publishType?: string;
};

export function parseTikTokPublicationWebhook(
	rawBody: string,
	expectedClientKey: string,
): TikTokPublicationEvent | null {
	let body: Record<string, unknown>;
	try {
		const parsed = JSON.parse(rawBody);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error();
		body = parsed as Record<string, unknown>;
	} catch {
		throw new TikTokPublicationWebhookError(
			"tiktok_webhook_payload_invalid",
			"TikTok webhook body must be a JSON object",
		);
	}
	if (body.client_key !== expectedClientKey) {
		throw new TikTokPublicationWebhookError(
			"tiktok_webhook_client_mismatch",
			"TikTok webhook client key does not match",
		);
	}
	if (
		body.event !== "post.publish.complete" &&
		body.event !== "post.publish.publicly_available" &&
		body.event !== "post.publish.failed" &&
		body.event !== "post.publish.inbox_delivered"
	) {
		return null;
	}
	let content: Record<string, unknown>;
	try {
		const parsed = JSON.parse(String(body.content ?? ""));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error();
		content = parsed as Record<string, unknown>;
	} catch {
		throw new TikTokPublicationWebhookError(
			"tiktok_webhook_payload_invalid",
			"TikTok webhook content must be serialized JSON",
		);
	}
	const publishId = content.publish_id;
	if (
		typeof publishId !== "string" ||
		publishId.length < 1 ||
		publishId.length > 64
	) {
		throw new TikTokPublicationWebhookError(
			"tiktok_webhook_payload_invalid",
			"TikTok publication webhook is missing publish_id",
		);
	}
	const postId =
		typeof content.post_id === "string" || typeof content.post_id === "number"
			? String(content.post_id)
			: null;
	const reason =
		typeof content.reason === "string" && content.reason.length <= 200
			? content.reason
			: null;
	return {
		event: body.event,
		publishId,
		postId,
		reason,
		publishType:
			typeof content.publish_type === "string"
				? content.publish_type
				: undefined,
	};
}

export async function acceptTikTokPublicationWebhook(input: {
	rawBody: string;
	signature: string | null;
	clientKey: string;
	clientSecret: string;
	now?: Date;
}) {
	const now = input.now ?? new Date();
	verifyTikTokWebhookSignature({
		rawBody: input.rawBody,
		signature: input.signature,
		clientSecret: input.clientSecret,
		now,
	});
	const event = parseTikTokPublicationWebhook(input.rawBody, input.clientKey);
	if (!event) return { kind: "ignored" as const };
	return recordTikTokPublicationEvent(event, now);
}

/** Both verified webhooks and an authenticated provider status read use this monotonic settlement. */
export async function recordTikTokPublicationEvent(
	event: TikTokPublicationEvent,
	now = new Date(),
) {
	const lookupHash = publicationOperationLookupHash(
		`tiktok:${event.publishId}`,
	);
	try {
		return await requirePrisma().$transaction(async (tx) => {
			// Serialize competing poll/webhook deliveries, including separate public posts from one upload.
			const candidates = await tx.socialPublicationAttempt.findMany({
				where: { operationLookupHash: lookupHash },
				select: { id: true },
				take: 1,
			});
			if (!candidates[0]) return { kind: "unknown_operation" as const };
			await tx.$queryRaw`SELECT "id" FROM "SocialPublicationAttempt" WHERE "id" = ${candidates[0].id}::uuid FOR UPDATE`;
			const attempt = await tx.socialPublicationAttempt.findUnique({
				where: { id: candidates[0].id },
				include: { receipt: true, socialPost: true, frozenState: true },
			});
			if (
				!attempt ||
				attempt.operationLookupHash !== lookupHash ||
				attempt.frozenState.platform !== "tiktok"
			)
				return { kind: "unknown_operation" as const };
			const inbox = attempt.frozenState.deliveryMode === "tiktok_inbox";
			if (event.publishType && (event.publishType === "INBOX_SHARE") !== inbox)
				return { kind: "ignored" as const };
			if (event.event === "post.publish.inbox_delivered" && !inbox)
				return { kind: "ignored" as const };
			if (attempt.socialPost.status === "cancelled")
				return { kind: "already_settled" as const, attemptId: attempt.id };
			if (event.event === "post.publish.failed") {
				if (attempt.receipt || attempt.phase === "succeeded")
					return { kind: "already_settled" as const, attemptId: attempt.id };
				const codes: Record<string, string> = {
					spam_risk: "tiktok_spam_risk",
					spam_risk_text: "tiktok_spam_risk",
					spam_risk_too_many_posts: "tiktok_rate_limit",
					spam_risk_too_many_pending_share: "tiktok_pending_drafts_limit",
					spam_risk_user_banned_from_posting: "tiktok_account_restricted",
					unaudited_client_can_only_post_to_private_accounts:
						"tiktok_audit_privacy_required",
				};
				const errorCode = codes[event.reason ?? ""] ?? "tiktok_publish_failed";
				await tx.socialPublicationAttempt.update({
					where: { id: attempt.id },
					data: {
						phase: "failed",
						outcome: "failed",
						failureCode: errorCode,
						failureDisposition: "permanent",
						terminalAt: now,
						currentClaimId: null,
					},
				});
				await tx.socialPost.update({
					where: { id: attempt.socialPostId },
					data: {
						status: "failed",
						errorCode,
						errorDisposition: "permanent",
						nextAttemptAt: null,
					},
				});
				if (attempt.currentClaimId)
					await tx.publicationClaim.updateMany({
						where: { id: attempt.currentClaimId, releasedAt: null },
						data: { releasedAt: now, accountSlotKey: null },
					});
				return { kind: "failed" as const, attemptId: attempt.id };
			}
			const published = event.event !== "post.publish.inbox_delivered";
			const account = attempt.socialPost.socialAccountId
				? await tx.socialAccount.findUnique({
						where: { id: attempt.socialPost.socialAccountId },
						select: { handle: true },
					})
				: null;
			const handle = account?.handle?.replace(/^@/, "") || "_";
			const alreadyRecorded = event.postId
				? await tx.publishedSocialVideo.findUnique({
						where: {
							socialPostId_platformPostId: {
								socialPostId: attempt.socialPostId,
								platformPostId: event.postId,
							},
						},
					})
				: null;
			const externalUrl = event.postId
				? `https://www.tiktok.com/@${encodeURIComponent(handle)}/video/${event.postId}`
				: null;
			await tx.providerReceipt.upsert({
				where: { attemptId: attempt.id },
				create: {
					attemptId: attempt.id,
					platform: "tiktok",
					receiptId: event.publishId,
					deliveryMode: published ? "direct" : "tiktok_inbox",
					inboxDeliveredAt: inbox ? now : null,
					platformPostId: event.postId,
					externalUrl,
				},
				update: published
					? {
							deliveryMode: "direct",
							...(event.postId
								? { platformPostId: event.postId, externalUrl }
								: {}),
						}
					: {},
			});
			if (published && event.postId)
				await tx.publishedSocialVideo.upsert({
					where: {
						socialPostId_platformPostId: {
							socialPostId: attempt.socialPostId,
							platformPostId: event.postId,
						},
					},
					create: {
						socialPostId: attempt.socialPostId,
						platformPostId: event.postId,
						externalUrl,
						publishedAt: now,
					},
					update: { externalUrl },
				});
			await tx.socialPublicationAttempt.update({
				where: { id: attempt.id },
				data: {
					phase: "succeeded",
					outcome: "accepted",
					failureCode: null,
					failureDisposition: null,
					terminalAt: attempt.terminalAt ?? now,
					currentClaimId: null,
				},
			});
			if (attempt.currentClaimId)
				await tx.publicationClaim.updateMany({
					where: { id: attempt.currentClaimId, releasedAt: null },
					data: { releasedAt: now, accountSlotKey: null },
				});
			const alreadyPosted = attempt.socialPost.status === "posted";
			await tx.socialPost.update({
				where: { id: attempt.socialPostId },
				data: {
					status: published || alreadyPosted ? "posted" : "inbox_delivered",
					postedAt: alreadyPosted
						? attempt.socialPost.postedAt
						: published
							? now
							: null,
					...(externalUrl ? { externalUrl } : {}),
					errorCode: null,
					errorDisposition: null,
					nextAttemptAt: null,
				},
			});
			if (published && !alreadyPosted) {
				await tx.publicationAnalyticsIntent.upsert({
					where: { attemptId: attempt.id },
					create: {
						attemptId: attempt.id,
						socialPostId: attempt.socialPostId,
						projectId: attempt.socialPost.projectId,
						kind: "social_posted",
						payload: { platform: "tiktok", evidence: "provider_report" },
						deliveredAt: now,
					},
					update: {},
				});
				await tx.projectAnalyticsEvent.create({
					data: {
						projectId: attempt.socialPost.projectId,
						clipId: attempt.socialPost.clipId,
						type: "social_posted",
						platform: "tiktok",
						metadata: {
							socialPostId: attempt.socialPostId,
							attemptId: attempt.id,
							evidence: "provider_report",
						},
					},
				});
			}
			return {
				kind:
					alreadyRecorded || (!published && attempt.receipt)
						? ("already_settled" as const)
						: published
							? ("posted" as const)
							: ("inbox_delivered" as const),
				attemptId: attempt.id,
			};
		});
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002"
		)
			return { kind: "already_settled" as const };
		throw error;
	}
}
