import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@narriflow/db/client";
import { socialOAuthService } from "./social-oauth.service";
import type { SocialPublicationMetrics } from "./social-publication-observability";

type YouTubeStatusResource = {
  status?: {
    uploadStatus?: string;
    failureReason?: string;
    rejectionReason?: string;
    privacyStatus?: string;
  };
};

function retryAfterMs(value: string | null, now: Date) {
	if (!value) return 0;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const instant = Date.parse(value);
	return Number.isFinite(instant) ? Math.max(0, instant - now.getTime()) : 0;
}

export function interpretYouTubeProcessingStatus(resource: YouTubeStatusResource) {
  const uploadStatus = resource.status?.uploadStatus ?? "uploaded";
  const failed = ["failed", "rejected", "deleted"].includes(uploadStatus);
  return {
    status: failed
      ? ("failed" as const)
      : uploadStatus === "processed"
        ? ("succeeded" as const)
        : ("processing" as const),
    failureCode: failed ? "youtube_processing_failed" : null,
    visibility: resource.status?.privacyStatus ?? null,
  };
}

export function createYouTubeReceiptEnricher(dependencies: {
  fetch: typeof fetch;
  metrics?: SocialPublicationMetrics;
  batchSize?: number;
  clock?: { now(): Date };
}) {
  return async function enrichYouTubeReceipts() {
    const prisma = getPrismaClient();
    if (!prisma) return 0;
    const now = dependencies.clock?.now() ?? new Date();
    const receipts = await prisma.providerReceipt.findMany({
      where: {
        platform: "youtube_shorts",
        enrichedAt: null,
        providerProcessingStatus: "processing",
        OR: [
          { enrichmentLeaseExpiresAt: null },
          { enrichmentLeaseExpiresAt: { lte: now } },
        ],
        AND: [
          {
            OR: [
              { enrichmentNextCheckAt: null },
              { enrichmentNextCheckAt: { lte: now } },
            ],
          },
        ],
      },
      select: {
        id: true,
        platformPostId: true,
        enrichmentCheckCount: true,
        attempt: {
          select: {
            socialPostId: true,
            processingDeadline: true,
            frozenState: { select: { socialAccountId: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
      take: dependencies.batchSize ?? 4,
    });
    let completed = 0;
    await Promise.all(receipts.map(async (receipt) => {
      const claimId = randomUUID();
      const claimed = await prisma.providerReceipt.updateMany({
        where: {
          id: receipt.id,
          enrichedAt: null,
          providerProcessingStatus: "processing",
          OR: [
            { enrichmentLeaseExpiresAt: null },
            { enrichmentLeaseExpiresAt: { lte: now } },
          ],
          AND: [
            {
              OR: [
                { enrichmentNextCheckAt: null },
                { enrichmentNextCheckAt: { lte: now } },
              ],
            },
          ],
        },
        data: {
          enrichmentClaimId: claimId,
          enrichmentLeaseExpiresAt: new Date(now.getTime() + 30_000),
        },
      });
      if (claimed.count !== 1) return;
      const accountId = receipt.attempt.frozenState.socialAccountId;
      const settleUnknown = async (
        failureCode = "youtube_processing_status_unknown",
      ) => {
        const settled = await prisma.$transaction(async (tx) => {
          const receiptUpdate = await tx.providerReceipt.updateMany({
            where: { id: receipt.id, enrichmentClaimId: claimId, enrichedAt: null },
            data: {
              providerProcessingStatus: "unknown",
              providerProcessingFailureCode: failureCode,
              enrichedAt: now,
              enrichmentClaimId: null,
              enrichmentLeaseExpiresAt: null,
              enrichmentNextCheckAt: null,
            },
          });
          if (receiptUpdate.count !== 1) return false;
          const postUpdate = await tx.socialPost.updateMany({
            where: { id: receipt.attempt.socialPostId, status: "posted" },
            data: {
              errorCode: failureCode,
              errorDisposition: "attention",
            },
          });
          if (postUpdate.count !== 1) {
            throw new Error("YouTube receipt projection changed during enrichment");
          }
          return true;
        });
        if (settled) completed += 1;
      };
      const releaseForRetry = (
		minimumDelayMs = 0,
		transientFailureCode?: string,
	) =>
        prisma.providerReceipt.updateMany({
          where: { id: receipt.id, enrichmentClaimId: claimId, enrichedAt: null },
          data: {
			providerProcessingFailureCode: transientFailureCode,
            enrichmentClaimId: null,
            enrichmentLeaseExpiresAt: null,
            enrichmentCheckCount: { increment: 1 },
            enrichmentNextCheckAt: new Date(
              now.getTime() + Math.max(
                minimumDelayMs,
                Math.min(30 * 60_000, 30_000 * 2 ** Math.min(receipt.enrichmentCheckCount, 6)),
              ),
            ),
          },
        });
      if (
        receipt.enrichmentCheckCount >= 100 ||
        receipt.attempt.processingDeadline <= now ||
        !accountId ||
        !receipt.platformPostId
      ) {
        await settleUnknown();
        return;
      }
      try {
        const account = await socialOAuthService.getPublishAccount(accountId);
        const response = await dependencies.fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(receipt.platformPostId)}`,
          {
            headers: { Authorization: `Bearer ${account.accessToken}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        dependencies.metrics?.observe(
          "social_publication_provider_operations_total",
          1,
          { platform: "youtube_shorts", operation: "receipt_enrichment" },
        );
        if (!response.ok) {
			if (response.status === 403) {
				let quotaExceeded = false;
				try {
					const body = (await response.clone().json()) as {
						error?: { errors?: Array<{ reason?: string }> };
					};
					quotaExceeded = [
						"quotaExceeded",
						"dailyLimitExceeded",
						"uploadLimitExceeded",
					].includes(body.error?.errors?.[0]?.reason ?? "");
				} catch {
					quotaExceeded = false;
				}
				if (quotaExceeded) {
					await releaseForRetry(60 * 60_000, "youtube_quota_exceeded");
					dependencies.metrics?.observe(
						"social_publication_rate_limits_total",
						1,
						{ platform: "youtube_shorts", operation: "receipt_enrichment" },
					);
					return;
				}
			}
			if (response.status === 401 || response.status === 403) {
				await settleUnknown(
					response.status === 401
						? "youtube_authentication_required"
						: "youtube_permission_required",
				);
				return;
			}
			if (response.status === 429) {
				await releaseForRetry(
					retryAfterMs(response.headers.get("retry-after"), now),
					"youtube_rate_limit",
				);
				dependencies.metrics?.observe(
					"social_publication_rate_limits_total",
					1,
					{ platform: "youtube_shorts", operation: "receipt_enrichment" },
				);
				return;
			}
			if (response.status >= 400 && response.status < 500) {
				await settleUnknown("youtube_processing_status_unavailable");
				return;
			}
			await releaseForRetry();
          return;
        }
        const body = (await response.json()) as { items?: YouTubeStatusResource[] };
        const resource = body.items?.[0];
        if (!resource) {
          await releaseForRetry();
          return;
        }
        const interpreted = interpretYouTubeProcessingStatus(resource);
        const updated = await prisma.$transaction(async (tx) => {
          const receiptUpdate = await tx.providerReceipt.updateMany({
            where: { id: receipt.id, enrichmentClaimId: claimId, enrichedAt: null },
            data: {
              providerProcessingStatus: interpreted.status,
              providerProcessingFailureCode: interpreted.failureCode,
              providerVisibility: interpreted.visibility,
              enrichedAt: interpreted.status === "processing" ? null : now,
              enrichmentClaimId: null,
              enrichmentLeaseExpiresAt: null,
              enrichmentCheckCount: { increment: 1 },
              enrichmentNextCheckAt:
                interpreted.status === "processing"
                  ? new Date(
                      now.getTime() +
                        Math.min(
                          30 * 60_000,
                          30_000 * 2 ** Math.min(receipt.enrichmentCheckCount, 6),
                        ),
                    )
                  : null,
            },
          });
          if (receiptUpdate.count !== 1) return false;
          if (interpreted.failureCode) {
            const postUpdate = await tx.socialPost.updateMany({
              where: { id: receipt.attempt.socialPostId, status: "posted" },
              data: {
                errorCode: interpreted.failureCode,
                errorDisposition: "permanent",
              },
            });
            if (postUpdate.count !== 1) {
              throw new Error("YouTube receipt projection changed during enrichment");
            }
          }
          return true;
        });
        if (!updated) return;
        if (interpreted.status !== "processing") completed += 1;
        dependencies.metrics?.observe(
          "social_publication_receipt_enrichment_total",
          1,
          { platform: "youtube_shorts", outcome: interpreted.status },
        );
      } catch (error) {
		const reconnectRequired =
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error.code === "social_account_expired" ||
				error.code === "social_account_missing");
		if (reconnectRequired) {
			await settleUnknown("social_account_reconnect_required").catch(
				() => undefined,
			);
		} else {
			await releaseForRetry().catch(() => undefined);
		}
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "social_publication_receipt_enrichment_failed",
            platform: "youtube_shorts",
            errorCode: "youtube_receipt_enrichment_failed",
          }),
        );
      }
    }));
    return completed;
  };
}
