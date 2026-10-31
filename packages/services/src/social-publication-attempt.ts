import {appendYouTubeReceiptEnrichment,trackPublishedVideo} from "./publication-observations";
import { lockPublicationAttempt, lockPublicationPost } from "./publication-locks";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { emitSocialPostFinished } from "./social-post-finished";
import type { SocialPublicationMetrics } from "./social-publication-observability";

export * from "./social-publication-driver";
import {
 PublicationClaimLostError,PublicationProviderCallBudgetError,retryActionAt,
 type PublicationAttemptSeed,
 type PublicationAttemptExecutionResult,type LoadedPublicationAttempt,type SocialPublicationAttemptStore,
 type OwnedPublicationAttempt,
} from "./social-publication-driver";

type InMemoryRecord = LoadedPublicationAttempt & {
	receipt: {
		receiptId: string;
		platformPostId: string | null;
		externalUrl: string | null;
	} | null;
	analyticsIntent: { kind: "social_posted"; attemptId: string } | null;
};

function cloneRecord(record: InMemoryRecord): InMemoryRecord {
	return structuredClone(record);
}

function requireOwned(
	records: Map<string, InMemoryRecord>,
	owned: OwnedPublicationAttempt,
): InMemoryRecord {
	const record = records.get(owned.attemptId);
	if (!record) throw new PublicationClaimLostError();
	if (record.terminalResult) return record;
	if (!record.claim || record.claim.id !== owned.claimId) {
		throw new PublicationClaimLostError();
	}
	return record;
}

export function createInMemorySocialPublicationAttemptStore(
	seeds: readonly PublicationAttemptSeed[],
): SocialPublicationAttemptStore & {
	inspect(attemptId: string): Promise<{
		socialPost: InMemoryRecord["socialPost"];
		attempt: InMemoryRecord["attempt"];
		claim: InMemoryRecord["claim"] | null;
		receipt: InMemoryRecord["receipt"];
		analyticsIntent: InMemoryRecord["analyticsIntent"];
	} | null>;
	takeOver(
		attemptId: string,
		claim: PublicationAttemptSeed["claim"],
	): Promise<void>;
} {
	const records = new Map<string, InMemoryRecord>();
	for (const seed of seeds) {
		records.set(seed.attempt.id, {
			...cloneRecord({
				...seed,
				sealedCheckpoint: seed.sealedCheckpoint ?? null,
				checkpointKind: seed.checkpointKind ?? null,
				terminalResult: null,
				receipt: null,
				analyticsIntent: null,
			}),
		});
	}

	return {
		async loadOwned(owned) {
			return cloneRecord(requireOwned(records, owned));
		},

		async checkpoint(input) {
			const record = requireOwned(records, input.owned);
			record.attempt.phase =
				input.operationKind === "submission_started"
					? "submission_started"
					: record.attempt.phase;
			if (input.operationKind === "submission_started") {
				record.attempt.phaseStartedAt = input.now;
			}
			record.checkpointKind = input.operationKind;
			record.sealedCheckpoint = input.sealedState;
		},

		async recordProviderCall(input) {
			const record = requireOwned(records, input.owned);
			if (record.attempt.providerCallCount >= input.maximum) {
				throw new PublicationProviderCallBudgetError();
			}
			record.attempt.providerCallCount += 1;
		},

		async settleAccepted(input) {
			const record = requireOwned(records, input.owned);
			if (record.terminalResult) return record.terminalResult;
			record.attempt.phase = "succeeded";
			record.attempt.outcome = "accepted";
			record.socialPost.status =
				input.result.receipt.deliveryMode === "tiktok_inbox"
					? "inbox_delivered"
					: "posted";
			record.socialPost.externalUrl = input.result.receipt.externalUrl;
			record.receipt = {
				receiptId: input.result.receipt.receiptId,
				platformPostId: input.result.receipt.platformPostId,
				externalUrl: input.result.receipt.externalUrl,
			};
			record.analyticsIntent =
				input.result.receipt.deliveryMode === "tiktok_inbox"
					? null
					: {
							kind: "social_posted",
							attemptId: record.attempt.id,
						};
			record.claim = null;
			record.terminalResult = {
				kind:
					input.result.receipt.deliveryMode === "tiktok_inbox"
						? "inbox_delivered"
						: "posted",
				attemptId: record.attempt.id,
				socialPostId: record.socialPost.id,
				externalUrl: input.result.receipt.externalUrl,
			};
			return structuredClone(record.terminalResult);
		},

		async settlePending(input) {
			const record = requireOwned(records, input.owned);
			const nextActionAt = new Date(
				Math.min(
					input.result.nextCheckAt.getTime(),
					(record.attempt.reconciliationOnly ? record.attempt.reconciliationDeadline : record.attempt.processingDeadline).getTime(),
				),
			);
			const nextPhase = record.attempt.reconciliationOnly ? "reconciling" :
				input.result.submissionStarted === false ? "uploading" : "processing";
			if (record.attempt.phase !== nextPhase) {
				record.attempt.phaseStartedAt = input.now;
			}
			record.attempt.phase = nextPhase;
			record.attempt.outcome = "pending";
			record.attempt.nextActionAt = nextActionAt;
			record.socialPost.status = record.attempt.reconciliationOnly ? "reconciling" : "processing";
			record.checkpointKind = input.result.operation.kind;
			record.sealedCheckpoint = input.sealedState;
			record.claim = null;
			return {
				kind: record.attempt.reconciliationOnly ? "reconciling" : "processing",
				attemptId: record.attempt.id,
				socialPostId: record.socialPost.id,
				nextActionAt,
			};
		},

		async settleUnknown(input) {
			const record = requireOwned(records, input.owned);
			record.attempt.outcome = "unknown";
			record.attempt.failureCode = input.code;
			record.checkpointKind = input.operation?.kind ?? record.checkpointKind;
			record.sealedCheckpoint = input.sealedState;
			record.claim = null;
			if (input.canReconcile && input.nextActionAt) {
				if (record.attempt.phase !== "reconciling") {
					record.attempt.phaseStartedAt = input.now;
				}
				record.attempt.phase = "reconciling";
				record.attempt.nextActionAt = input.nextActionAt;
				record.socialPost.status = "reconciling";
				return {
					kind: "reconciling",
					attemptId: record.attempt.id,
					socialPostId: record.socialPost.id,
					nextActionAt: input.nextActionAt,
				};
			}
			record.attempt.phase = "needs_attention";
			record.socialPost.status = "needs_attention";
			record.socialPost.errorCode = input.code;
			record.terminalResult = {
				kind: "needs_attention",
				attemptId: record.attempt.id,
				socialPostId: record.socialPost.id,
				code: input.code,
			};
			return structuredClone(record.terminalResult);
		},

		async settleFailed(input) {
			const record = requireOwned(records, input.owned);
			const needsAttention =
				input.disposition === "attention" ||
				(input.disposition === "safe_retry" && input.submissionMayHaveStarted);
			if (needsAttention) {
				record.attempt.phase = "needs_attention";
				record.attempt.outcome = input.submissionMayHaveStarted
					? "unknown"
					: "failed";
				record.attempt.failureCode = input.code;
				record.attempt.failureEvidence = input.failureEvidence ?? null;
				record.attempt.failureDisposition = "attention";
				record.socialPost.status = "needs_attention";
				record.socialPost.errorCode = input.code;
				record.claim = null;
				record.terminalResult = {
					kind: "needs_attention",
					attemptId: record.attempt.id,
					socialPostId: record.socialPost.id,
					code: input.code,
				};
				return structuredClone(record.terminalResult);
			}
			record.attempt.phase = "failed";
			record.attempt.outcome = "failed";
			record.attempt.failureCode = input.code;
			record.attempt.failureEvidence = input.failureEvidence ?? null;
			record.attempt.failureDisposition = input.disposition;
			record.socialPost.status = "failed";
			record.socialPost.errorCode = input.code;
			record.claim = null;
			const retryCandidate =
				input.disposition === "safe_retry" &&
				!input.submissionMayHaveStarted &&
				record.attempt.attemptNumber < input.retry.maxAttempts;
			const nextActionAt = retryCandidate
				? retryActionAt({
						now: input.now,
						attemptNumber: record.attempt.attemptNumber,
						retryAfterMs: input.retryAfterMs,
						retry: input.retry,
					})
				: null;
			let lineageRecord = record;
			while (lineageRecord.attempt.priorAttemptId) {
				const prior = records.get(lineageRecord.attempt.priorAttemptId);
				if (!prior) break;
				lineageRecord = prior;
			}
			const lineageDeadline =
				lineageRecord.attempt.startedAt.getTime() + input.retry.maxElapsedMs;
			if (nextActionAt && nextActionAt.getTime() <= lineageDeadline) {
				record.socialPost.status = "scheduled";
				record.socialPost.errorCode = input.code;
				record.socialPost.nextAttemptAt = nextActionAt;
				const nextAttemptId = `attempt-${record.attempt.attemptNumber + 1}`;
				const nextRecord: InMemoryRecord = cloneRecord({
					socialPost: record.socialPost,
					frozen: record.frozen,
					attempt: {
						id: nextAttemptId,
						attemptNumber: record.attempt.attemptNumber + 1,
						priorAttemptId: record.attempt.id,
						idempotencyKey: `${record.attempt.idempotencyKey}:retry:${record.attempt.attemptNumber + 1}`,
						phase: "retry_scheduled",
						outcome: null,
						nextActionAt,
						providerCallCount: 0,
						startedAt: input.now,
						processingDeadline: new Date(
							nextActionAt.getTime() + input.processingDeadlineMs,
						),
						reconciliationDeadline: new Date(
							nextActionAt.getTime() + input.reconciliationDeadlineMs,
						),
					},
					claim: null,
					checkpointKind: null,
					sealedCheckpoint: null,
					terminalResult: null,
					receipt: null,
					analyticsIntent: null,
				});
				records.set(nextAttemptId, nextRecord);
				record.terminalResult = {
					kind: "retry_scheduled",
					attemptId: record.attempt.id,
					socialPostId: record.socialPost.id,
					nextAttemptId,
					nextActionAt,
				};
				return structuredClone(record.terminalResult);
			}
			record.terminalResult = {
				kind: "failed",
				attemptId: record.attempt.id,
				socialPostId: record.socialPost.id,
				code: input.code,
			};
			return structuredClone(record.terminalResult);
		},

		async releaseInterrupted(input) {
			const record = requireOwned(records, input.owned);
			record.claim = null;
			record.attempt.nextActionAt = input.now;
			return {
				kind: "interrupted",
				attemptId: record.attempt.id,
				socialPostId: record.socialPost.id,
			};
		},

		async inspect(attemptId) {
			const record = records.get(attemptId);
			if (!record) return null;
			return structuredClone({
				socialPost: record.socialPost,
				attempt: record.attempt,
				claim: record.claim,
				receipt: record.receipt,
				analyticsIntent: record.analyticsIntent,
			});
		},

		async takeOver(attemptId, claim) {
			const record = records.get(attemptId);
			if (!record) throw new Error("attempt not found");
			record.claim = structuredClone(claim);
		},
	};
}

const manualRecheckSelect = {
	where: { kind: "recheck_requested" as const },
	take: 1,
	select: { id: true },
};

const publicationAttemptInclude = {
	socialPost: true,
	frozenState: true,
	claims: { orderBy: { createdAt: "desc" as const } },
	receipt: true,
	analyticsIntent: true,
	manualDecisions: manualRecheckSelect,
};

type PublicationAttemptRow = Prisma.SocialPublicationAttemptGetPayload<{
	include: typeof publicationAttemptInclude;
}>;

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function rowExecutionResult(
	row: PublicationAttemptRow,
): PublicationAttemptExecutionResult | null {
	if (row.phase === "succeeded" && row.receipt) {
		return {
			kind:
				row.receipt.deliveryMode === "tiktok_inbox"
					? "inbox_delivered"
					: "posted",
			attemptId: row.id,
			socialPostId: row.socialPostId,
			externalUrl: row.receipt.externalUrl,
		};
	}
	if (row.phase === "failed") {
		return {
			kind: "failed",
			attemptId: row.id,
			socialPostId: row.socialPostId,
			code: row.failureCode ?? "social_publish_failed",
		};
	}
	if (row.phase === "needs_attention") {
		return {
			kind: "needs_attention",
			attemptId: row.id,
			socialPostId: row.socialPostId,
			code: row.failureCode ?? "publication_outcome_unknown",
		};
	}
	return null;
}

function rowToLoadedAttempt(
	row: PublicationAttemptRow,
): LoadedPublicationAttempt {
	const claim = row.currentClaimId
		? (row.claims.find((candidate) => candidate.id === row.currentClaimId) ??
			null)
		: null;
	return {
		socialPost: {
			id: row.socialPost.id,
			workspaceId: row.socialPost.workspaceId!,
			projectId: row.socialPost.projectId,
			status: row.socialPost
				.status as LoadedPublicationAttempt["socialPost"]["status"],
			scheduledFor: row.socialPost.scheduledFor!,
			nextAttemptAt: row.socialPost.nextAttemptAt,
			externalUrl: row.socialPost.externalUrl,
			errorCode: row.socialPost.errorCode,
		},
		frozen: {
			clipExportId: row.frozenState.clipExportId,
			clipExportVariantId: row.frozenState.clipExportVariantId,
			editorRevision: row.frozenState.editorRevision,
			exportFingerprint: row.frozenState.exportFingerprint,
			storageKey: row.frozenState.storageKey,
			sizeBytes:
				row.frozenState.sizeBytes === null
					? null
					: Number(row.frozenState.sizeBytes),
			durationSec: row.frozenState.durationSec,
			aspectRatio:
				row.frozenState.aspectRatio === "ratio_9_16"
					? "9:16"
					: row.frozenState.aspectRatio === "ratio_1_1"
						? "1:1"
						: row.frozenState.aspectRatio === "ratio_16_9"
							? "16:9"
							: "4:5",
			caption: row.frozenState.caption,
			providerSettings:
				row.frozenState.providerSettings &&
				typeof row.frozenState.providerSettings === "object" &&
				!Array.isArray(row.frozenState.providerSettings)
					? (row.frozenState.providerSettings as Prisma.JsonObject)
					: {},
			socialAccountId: row.frozenState.socialAccountId,
			platform: row.frozenState.platform,
			capabilityVersion: row.frozenState.capabilityVersion,
			scheduledFor: row.frozenState.scheduledFor,
		},
		attempt: {
			id: row.id,
			attemptNumber: row.attemptNumber,
			priorAttemptId: row.priorAttemptId,
			idempotencyKey: row.idempotencyKey,
			phase: row.phase,
			outcome: row.outcome,
			nextActionAt: row.nextActionAt,
			providerCallCount: row.providerCallCount,
			startedAt: row.startedAt,
			phaseStartedAt: row.phaseStartedAt,
			processingDeadline: row.processingDeadline,
			reconciliationDeadline: row.reconciliationDeadline,
			reconciliationOnly: row.manualDecisions.length > 0,
			failureCode: row.failureCode,
			failureDisposition: row.failureDisposition,
		},
		claim: claim
			? {
					id: claim.id,
					claimantId: claim.claimantId,
					leaseExpiresAt: claim.leaseExpiresAt,
					heartbeatAt: claim.heartbeatAt,
				}
			: null,
		sealedCheckpoint: row.checkpointEncrypted,
		checkpointKind: row.operationKind,
		terminalResult: rowExecutionResult(row),
	};
}

async function requireCurrentClaim(
	tx: Prisma.TransactionClient,
	owned: OwnedPublicationAttempt,
	now: Date,
) {
 await lockPublicationAttempt(tx,owned.attemptId);
 await tx.$queryRaw`SELECT "id" FROM "PublicationClaim" WHERE "id"=${owned.claimId}::uuid FOR UPDATE`;
	const attempt = await tx.socialPublicationAttempt.findFirst({
		where: { id: owned.attemptId, currentClaimId: owned.claimId },
		select: { id: true },
	});
	const claim = attempt
		? await tx.publicationClaim.findFirst({
				where: {
					id: owned.claimId,
					attemptId: owned.attemptId,
					releasedAt: null,
					leaseExpiresAt: { gt: now },
				},
				select: { id: true },
			})
		: null;
	if (!attempt || !claim) throw new PublicationClaimLostError();
}

async function releaseCurrentClaim(
	tx: Prisma.TransactionClient,
	owned: OwnedPublicationAttempt,
	now: Date,
) {
	await tx.publicationClaim.updateMany({
		where: {
			id: owned.claimId,
			attemptId: owned.attemptId,
			releasedAt: null,
		},
		data: { releasedAt: now, accountSlotKey: null },
	});
	await tx.socialPublicationAttempt.updateMany({
		where: { id: owned.attemptId, currentClaimId: owned.claimId },
		data: { currentClaimId: null },
	});
}

export class ProviderReceiptConflictError extends Error {
	readonly code = "provider_receipt_conflict";

	constructor() {
		super(
			"Provider evidence conflicts with the receipt already stored for this attempt",
		);
		this.name = "ProviderReceiptConflictError";
	}
}

export function createPrismaSocialPublicationAttemptStore(database: () => PrismaClient | Prisma.TransactionClient): SocialPublicationAttemptStore {
 const transaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
  const client=database();
  return "$transaction" in client ? client.$transaction(work) : work(client);
 };
 return {
		async loadOwned(owned, now) {
			const row = await database().socialPublicationAttempt.findUnique({
				where: { id: owned.attemptId },
				include: publicationAttemptInclude,
			});
			if (!row) throw new PublicationClaimLostError();
			const terminal = rowExecutionResult(row);
			if (!terminal) {
				const claim = row.claims.find(
					(candidate) => candidate.id === owned.claimId,
				);
				if (
					row.currentClaimId !== owned.claimId ||
					!claim ||
					claim.releasedAt ||
					claim.leaseExpiresAt <= now
				) {
					throw new PublicationClaimLostError();
				}
			}
			return rowToLoadedAttempt(row);
		},

		async checkpoint(input) {
			await transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const updated = await tx.socialPublicationAttempt.updateMany({
					where: {
						id: input.owned.attemptId,
						currentClaimId: input.owned.claimId,
					},
					data: {
						phase:
							input.operationKind === "submission_started"
								? "submission_started"
								: undefined,
						phaseStartedAt:
							input.operationKind === "submission_started"
								? input.now
								: undefined,
						operationKind: input.operationKind,
						checkpointEncrypted: input.sealedState,
						operationLookupHash: input.operationLookupHash,
					},
				});
				if (updated.count !== 1) throw new PublicationClaimLostError();
			});
		},

		async recordProviderCall(input) {
			await transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const updated = await tx.socialPublicationAttempt.updateMany({
					where: {
						id: input.owned.attemptId,
						currentClaimId: input.owned.claimId,
						providerCallCount: { lt: input.maximum },
					},
					data: { providerCallCount: { increment: 1 } },
				});
				if (updated.count !== 1) {
					throw new PublicationProviderCallBudgetError();
				}
			});
		},

		async settleAccepted(input) {
			try {
				return await transaction(async (tx) => {
					await lockPublicationAttempt(tx,input.owned.attemptId);
					const row = await tx.socialPublicationAttempt.findUnique({
						where: { id: input.owned.attemptId },
						include: publicationAttemptInclude,
					});
					if (!row) throw new PublicationClaimLostError();
					if (row.phase === "succeeded" && row.receipt) {
						if (
							row.receipt.receiptId !== input.result.receipt.receiptId ||
							(row.receipt.platformPostId &&
								input.result.receipt.platformPostId &&
								row.receipt.platformPostId !==
									input.result.receipt.platformPostId)
						) {
							throw new ProviderReceiptConflictError();
						}
						return rowExecutionResult(row)!;
					}
					await requireCurrentClaim(tx, input.owned, input.now);
					const receipt=await tx.providerReceipt.create({
						data: {
							attemptId: row.id,
							platform: row.frozenState.platform,
							receiptId: input.result.receipt.receiptId,
							deliveryMode: input.result.receipt.deliveryMode ?? "direct",
							inboxDeliveredAt:
								input.result.receipt.deliveryMode === "tiktok_inbox"
									? input.now
									: null,
							platformPostId: input.result.receipt.platformPostId,
							externalUrl: input.result.receipt.externalUrl,
							providerProcessingStatus:
								input.result.receipt.providerProcessingStatus ?? null,
							providerProcessingFailureCode:
								input.result.receipt.providerProcessingFailureCode ?? null,
							providerVisibility:
								input.result.receipt.providerVisibility ?? null,
							enrichmentNextCheckAt:
								input.result.receipt.providerProcessingStatus === "processing"
									? new Date(input.now.getTime() + 30_000)
									: null,
							enrichedAt:
								input.result.receipt.providerProcessingStatus &&
								input.result.receipt.providerProcessingStatus !== "processing"
									? input.now
									: null,
						},
					});
					if (input.result.receipt.deliveryMode !== "tiktok_inbox") {
						await tx.publicationAnalyticsIntent.create({
							data: {
								attemptId: row.id,
								socialPostId: row.socialPostId,
								projectId: row.socialPost.projectId,
								kind: "social_posted",
								payload: {
									platform: row.frozenState.platform,
									receiptId: input.result.receipt.receiptId,
								},
								deliveredAt: input.now,
							},
						});
						await tx.projectAnalyticsEvent.create({
							data: {
								projectId: row.socialPost.projectId,
								clipId: row.socialPost.clipId,
								type: "social_posted",
								platform: row.frozenState.platform,
								metadata: {
									socialPostId: row.socialPostId,
									attemptId: row.id,
									receiptId: input.result.receipt.receiptId,
								},
							},
						});
					}
					await tx.socialPublicationAttempt.update({
						where: { id: row.id },
						data: {
							phase: "succeeded",
							outcome: "accepted",
							failureCode: null,
							failureDisposition: null,
							terminalAt: input.now,
						},
					});
					await tx.socialPost.update({
						where: { id: row.socialPostId },
						data: {
							status:
								input.result.receipt.deliveryMode === "tiktok_inbox"
									? "inbox_delivered"
									: "posted",
							postedAt:
								input.result.receipt.deliveryMode === "tiktok_inbox"
									? null
									: input.now,
							externalUrl: input.result.receipt.externalUrl,
							errorCode:
								input.result.receipt.providerProcessingFailureCode ?? null,
							errorDisposition: input.result.receipt
								.providerProcessingFailureCode
								? "permanent"
								: null,
							nextAttemptAt: null,
						},
					});
					// A video the platform itself verified: native adapters list its
					// post IDs (none for a TikTok inbox delivery or a failed YouTube
					// processing). A webhook receiver's self-reported ID never qualifies.
					const publishedIds = input.result.receipt.platformPostIds ?? [];
					for (const postId of publishedIds) {
						await tx.publishedSocialVideo.upsert({
							where: {
								socialPostId_platformPostId: {
									socialPostId: row.socialPostId,
									platformPostId: postId,
								},
							},
							create: {
								socialPostId: row.socialPostId,
								platformPostId: postId,
								externalUrl:
									row.frozenState.platform === "tiktok"
										? `https://www.tiktok.com/@_/video/${postId}`
										: input.result.receipt.externalUrl,
							},
							update: {},
						});
					}
     await appendYouTubeReceiptEnrichment(tx,receipt.id);
     for(const platformPostId of publishedIds)await trackPublishedVideo(tx,{socialPostId:row.socialPostId,platformPostId});
					await releaseCurrentClaim(tx, input.owned, input.now);
					await emitSocialPostFinished(tx, { socialPostId: row.socialPostId, attemptId: row.id });
					return {
						kind:
							input.result.receipt.deliveryMode === "tiktok_inbox"
								? "inbox_delivered"
								: "posted",
						attemptId: row.id,
						socialPostId: row.socialPostId,
						externalUrl: input.result.receipt.externalUrl,
					};
				});
			} catch (error) {
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === "P2002"
				) {
					throw new ProviderReceiptConflictError();
				}
				throw error;
			}
		},

		async settlePending(input) {
			return transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const current = await tx.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: input.owned.attemptId },
					select: { processingDeadline: true, reconciliationDeadline: true, phase: true, manualDecisions: manualRecheckSelect },
				});
				const reconciliationOnly = current.manualDecisions.length > 0;
				const nextActionAt = new Date(
					Math.min(
						input.result.nextCheckAt.getTime(),
						(reconciliationOnly ? current.reconciliationDeadline : current.processingDeadline).getTime(),
					),
				);
				const nextPhase = reconciliationOnly ? "reconciling" :
					input.result.submissionStarted === false ? "uploading" : "processing";
				const row = await tx.socialPublicationAttempt.update({
					where: { id: input.owned.attemptId },
					data: {
						phase: nextPhase,
						outcome: "pending",
						phaseStartedAt: current.phase === nextPhase ? undefined : input.now,
						nextActionAt,
						operationKind: input.result.operation.kind,
						checkpointEncrypted: input.sealedState,
						operationLookupHash: input.operationLookupHash,
					},
					select: { id: true, socialPostId: true },
				});
				await tx.socialPost.update({
					where: { id: row.socialPostId },
					data: {
						status: reconciliationOnly ? "reconciling" : "processing",
						nextAttemptAt: nextActionAt,
					},
				});
				await releaseCurrentClaim(tx, input.owned, input.now);
				return {
					kind: reconciliationOnly ? "reconciling" : "processing",
					attemptId: row.id,
					socialPostId: row.socialPostId,
					nextActionAt,
				};
			});
		},

		async settleUnknown(input) {
			return transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const current = await tx.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: input.owned.attemptId },
					select: { phase: true },
				});
				const phase = input.canReconcile ? "reconciling" : "needs_attention";
				const row = await tx.socialPublicationAttempt.update({
					where: { id: input.owned.attemptId },
					data: {
						phase,
						outcome: "unknown",
						phaseStartedAt: current.phase === phase ? undefined : input.now,
						failureCode: input.code,
						failureDisposition: "attention",
						operationKind: input.operation?.kind,
						checkpointEncrypted: input.sealedState,
						nextActionAt: input.nextActionAt ?? input.now,
						terminalAt: input.canReconcile ? null : input.now,
					},
					select: { id: true, socialPostId: true },
				});
				await tx.socialPost.update({
					where: { id: row.socialPostId },
					data: {
						status: input.canReconcile ? "reconciling" : "needs_attention",
						errorCode: input.code,
						errorDisposition: "attention",
						nextAttemptAt: input.nextActionAt,
					},
				});
				await releaseCurrentClaim(tx, input.owned, input.now);
				await emitSocialPostFinished(tx, { socialPostId: row.socialPostId, attemptId: row.id });
				return input.canReconcile && input.nextActionAt
					? {
							kind: "reconciling",
							attemptId: row.id,
							socialPostId: row.socialPostId,
							nextActionAt: input.nextActionAt,
						}
					: {
							kind: "needs_attention",
							attemptId: row.id,
							socialPostId: row.socialPostId,
							code: input.code,
						};
			});
		},

		async settleFailed(input) {
			return transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const row = await tx.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: input.owned.attemptId },
					include: { socialPost: true, frozenState: true },
				});
				const needsAttention =
					input.disposition === "attention" ||
					(input.disposition === "safe_retry" &&
						input.submissionMayHaveStarted);
				if (needsAttention) {
					await tx.socialPublicationAttempt.update({
						where: { id: row.id },
						data: {
							phase: "needs_attention",
							outcome: input.submissionMayHaveStarted ? "unknown" : "failed",
							failureCode: input.code,
							failureEvidence: input.failureEvidence,
							failureDisposition: "attention",
							terminalAt: input.now,
						},
					});
					await tx.socialPost.update({
						where: { id: row.socialPostId },
						data: {
							status: "needs_attention",
							errorCode: input.code,
							errorDisposition: "attention",
							nextAttemptAt: null,
						},
					});
					await releaseCurrentClaim(tx, input.owned, input.now);
					await emitSocialPostFinished(tx, { socialPostId: row.socialPostId, attemptId: row.id });
					return {
						kind: "needs_attention",
						attemptId: row.id,
						socialPostId: row.socialPostId,
						code: input.code,
					};
				}
				const lineageStart = await tx.socialPublicationAttempt.findFirstOrThrow(
					{
						where: { socialPostId: row.socialPostId },
						orderBy: [{ attemptNumber: "asc" }, { startedAt: "asc" }],
						select: { startedAt: true },
					},
				);
				const retryCandidate =
					input.disposition === "safe_retry" &&
					!input.submissionMayHaveStarted &&
					row.attemptNumber < input.retry.maxAttempts;
				const nextActionAt = retryCandidate
					? retryActionAt({
							now: input.now,
							attemptNumber: row.attemptNumber,
							retryAfterMs: input.retryAfterMs,
							retry: input.retry,
						})
					: null;
				const lineageDeadline =
					lineageStart.startedAt.getTime() + input.retry.maxElapsedMs;
				await tx.socialPublicationAttempt.update({
					where: { id: row.id },
					data: {
						phase: "failed",
						outcome: "failed",
						failureCode: input.code,
						failureEvidence: input.failureEvidence,
						failureDisposition: input.disposition,
						terminalAt: input.now,
					},
				});
				if (nextActionAt && nextActionAt.getTime() <= lineageDeadline) {
					const nextAttemptId = randomUUID();
					await tx.socialPublicationAttempt.create({
						data: {
                            providerCallCeiling:row.providerCallCeiling,nativeStartCeiling:row.nativeStartCeiling,executionActorUserId:row.executionActorUserId,
							id: nextAttemptId,
							socialPostId: row.socialPostId,
							frozenStateId: row.frozenStateId,
							attemptNumber: row.attemptNumber + 1,
							priorAttemptId: row.id,
							idempotencyKey: `${row.idempotencyKey}:retry:${row.attemptNumber + 1}`,
							phase: "retry_scheduled",
							nextActionAt,
							processingDeadline: new Date(
								nextActionAt.getTime() + input.processingDeadlineMs,
							),
							reconciliationDeadline: new Date(
								nextActionAt.getTime() + input.reconciliationDeadlineMs,
							),
						},
					});
					await tx.socialPost.update({
						where: { id: row.socialPostId },
						data: {
							status: "scheduled",
							errorCode: input.code,
							errorDisposition: input.disposition,
							nextAttemptAt: nextActionAt,
						},
					});
					await releaseCurrentClaim(tx, input.owned, input.now);
					return {
						kind: "retry_scheduled",
						attemptId: row.id,
						socialPostId: row.socialPostId,
						nextAttemptId,
						nextActionAt,
					};
				}
				await tx.socialPost.update({
					where: { id: row.socialPostId },
					data: {
						status: "failed",
						errorCode: input.code,
						errorDisposition: input.disposition,
						nextAttemptAt: null,
					},
				});
				await tx.publicationAnalyticsIntent.upsert({
					where: { attemptId: row.id },
					create: {
						attemptId: row.id,
						socialPostId: row.socialPostId,
						projectId: row.socialPost.projectId,
						kind: "social_failed",
						payload: { code: input.code, disposition: input.disposition },
					},
					update: {},
				});
				await releaseCurrentClaim(tx, input.owned, input.now);
				await emitSocialPostFinished(tx, { socialPostId: row.socialPostId, attemptId: row.id });
				return {
					kind: "failed",
					attemptId: row.id,
					socialPostId: row.socialPostId,
					code: input.code,
				};
			});
		},

		async releaseInterrupted(input) {
			return transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const row = await tx.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: input.owned.attemptId },
					select: { id: true, socialPostId: true },
				});
				// The post stays publishing: a claimed attempt is only reclaimed
				// while its post is publishing, so the next poll resumes it.
				await tx.socialPublicationAttempt.update({
					where: { id: row.id },
					data: { nextActionAt: input.now },
				});
				await releaseCurrentClaim(tx, input.owned, input.now);
				return {
					kind: "interrupted",
					attemptId: row.id,
					socialPostId: row.socialPostId,
				};
			});
		},
	};
}
export const prismaSocialPublicationAttemptStore = createPrismaSocialPublicationAttemptStore(requirePrisma);

export type PublicationClaimConfig = {
	batchSize: number;
	leaseMs: number;
	processingDeadlineMs: number;
	reconciliationDeadlineMs: number;
	providerCallBudget: number;
};

const publicationClaimCandidateInclude = {
	socialPost: { include: { workspace: true } },
	frozenState: { include: { socialAccount: true } },
	claims: { orderBy: { createdAt: "desc" as const }, take: 1 },
};

type PublicationClaimCandidate = Prisma.SocialPublicationAttemptGetPayload<{
	include: typeof publicationClaimCandidateInclude;
}>;

class PublicationClaimAdmissionRaceError extends Error {}

export async function synchronizePreparedSocialPosts(now = new Date()) {
	const prisma = requirePrisma();
	const states = await prisma.frozenPublicationState.findMany({
		where: {
			socialPost: { status: "preparing_video" },
			OR: [
				{
					clipExportVariant: { status: "completed", storageKey: { not: null } },
				},
				{ clipExportVariant: { status: "failed" } },
			],
		},
		include: { clipExportVariant: true },
	});
	for (const state of states) {
  const socialPostId=state.socialPostId;if(!socialPostId)throw Error("Detached publication snapshot selected as current");
		if (
			state.clipExportVariant.status === "completed" &&
			state.clipExportVariant.storageKey &&
			state.clipExportVariant.sizeBytes !== null &&
			state.clipExportVariant.durationSec !== null
		) {
			await prisma.$transaction(async (tx) => {
				await tx.frozenPublicationState.updateMany({
					where: { id: state.id, storageKey: null },
					data: {
						storageKey: state.clipExportVariant.storageKey,
						sizeBytes: state.clipExportVariant.sizeBytes,
						durationSec: state.clipExportVariant.durationSec,
						mediaReadyAt: now,
					},
				});
				await tx.socialPost.updateMany({
					where: { id: socialPostId, status: "preparing_video" },
					data: { status: "scheduled" },
				});
			});
		} else if (
			state.clipExportVariant.status === "failed" ||
			state.clipExportVariant.status === "completed"
		) {
			await prisma.$transaction(async (tx) => {
				const failed = await tx.socialPost.updateMany({
					where: { id: socialPostId, status: "preparing_video" },
					data: {
						status: "failed",
						errorCode:
							state.clipExportVariant.errorCode ??
							(state.clipExportVariant.status === "completed"
								? "publication_media_duration_missing"
								: "publication_media_preparation_failed"),
						errorDisposition: "permanent",
					},
				});
				if (failed.count === 1) await emitSocialPostFinished(tx, { socialPostId });
			});
		}
	}
	return states.length;
}

export async function claimDueSocialPublicationAttempts(input: {
	claimantId: string;
	now: Date;
	config: PublicationClaimConfig;
	createId?: () => string;
	metrics?: SocialPublicationMetrics;
}): Promise<OwnedPublicationAttempt[]> {
	const prisma = requirePrisma();
	const createId = input.createId ?? randomUUID;
	await synchronizePreparedSocialPosts(input.now);

	const duePosts = await prisma.socialPost.findMany({
		where: {
			status: "scheduled",
			scheduledFor: { lte: input.now },
			OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: input.now } }],
			workspace: { status: "active" },
			// A post a Standing Grant accepted goes out only while that grant is active. A paused grant
			// holds its posts until it is renewed; a revoked or expired one gives them back to the inbox.
			AND: [{ OR: [{ standingGrantId: null }, { standingGrant: { is: { status: "active", expiresAt: { gt: input.now } } } }] }],
			frozenState: {
				is: {
					storageKey: { not: null },
					sizeBytes: { not: null },
					durationSec: { not: null },
				},
			},
			publicationAttempts: { none: {} },
		},
		include: { frozenState: true },
		orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
		take: input.config.batchSize * 3,
	});
	for (const post of duePosts) {
		if (!post.frozenState) continue;
		await prisma
			.$transaction(async (tx) => {
                await lockPublicationPost(tx,post.id);
				const [locked] = await tx.$queryRaw<Array<{ status: string; standingGrantId: string | null }>>`
          SELECT "status"::text AS "status", "standingGrantId"
          FROM "SocialPost"
          WHERE "id" = ${post.id}::uuid
          FOR UPDATE
        `;
				if (locked?.status !== "scheduled") return;
				if (locked.standingGrantId) {
					// Shared, so a pause, revocation or expiry committed first is seen here, and one that
					// comes after waits until this attempt exists. The post's lock is taken first, then
					// the grant's, which is the order settlement and the pause hook already use.
					const [grant] = await tx.$queryRaw<Array<{ live: boolean }>>`
            SELECT ("status" = 'active' AND "expiresAt" > (${input.now.toISOString()}::timestamptz AT TIME ZONE 'UTC')) AS "live"
            FROM "StandingGrant"
            WHERE "id" = ${locked.standingGrantId}::uuid
            FOR SHARE
          `;
					if (!grant?.live) return;
				}
				await tx.socialPublicationAttempt.create({
					data: {
						id: createId(),
						socialPostId: post.id,
						frozenStateId: post.frozenState!.id,
						attemptNumber: 1,
						idempotencyKey: `publication:${post.id}:1`,
						phase: "retry_scheduled",
						nextActionAt: input.now,
						processingDeadline: new Date(
							input.now.getTime() + input.config.processingDeadlineMs,
						),
						reconciliationDeadline: new Date(
							input.now.getTime() + input.config.reconciliationDeadlineMs,
						),
					},
				});
			})
			.catch((error) => {
				if (
					!(
						error instanceof Prisma.PrismaClientKnownRequestError &&
						error.code === "P2002"
					)
				) {
					throw error;
				}
			});
	}

	const owned: OwnedPublicationAttempt[] = [];
	const pageSize = Math.max(20, input.config.batchSize * 4);
	const maximumScan = 5_000;
	let scanned = 0;
	let cursor: { nextActionAt: Date; id: string } | null = null;
	while (owned.length < input.config.batchSize && scanned < maximumScan) {
		const candidates: PublicationClaimCandidate[] =
			await prisma.socialPublicationAttempt.findMany({
				where: {
					phase: {
						in: [
							"claimed",
							"preparing",
							"uploading",
							"submission_started",
							"processing",
							"reconciling",
							"retry_scheduled",
						],
					},
					nextActionAt: { lte: input.now },
					...(cursor
						? {
								OR: [
									{ nextActionAt: { gt: cursor.nextActionAt } },
									{
										nextActionAt: cursor.nextActionAt,
										id: { gt: cursor.id },
									},
								],
							}
						: {}),
				},
				include: publicationClaimCandidateInclude,
				orderBy: [{ nextActionAt: "asc" }, { id: "asc" }],
				take: Math.min(pageSize, maximumScan - scanned),
			});
		if (candidates.length === 0) break;
		const lastCandidate = candidates.at(-1)!;
		cursor = {
			nextActionAt: lastCandidate.nextActionAt,
			id: lastCandidate.id,
		};
		scanned += candidates.length;
		for (const candidate of candidates) {
			if (owned.length >= input.config.batchSize) break;
			const submitted =
				candidate.phase === "submission_started" ||
				candidate.phase === "processing" ||
				candidate.phase === "reconciling";
			if (!submitted && candidate.socialPost.workspace?.status !== "active")
				continue;
			const claimId = createId();
			let leaseTakenOver = false;
			try {
				const claimed = await prisma.$transaction(async (tx) => {
                    await lockPublicationAttempt(tx,candidate.id);
					const current = await tx.socialPublicationAttempt.findUnique({
						where: { id: candidate.id },
						include: {
							socialPost: { select: { status: true } },
							frozenState: {
								select: { socialAccount: { select: { status: true } } },
							},
							claims: { orderBy: { createdAt: "desc" }, take: 1 },
						},
					});
					if (!current) return false;
					const currentSubmitted =
						current.phase === "submission_started" ||
						current.phase === "processing" ||
						current.phase === "reconciling";
					const expectedPreSubmissionStatus =
						current.phase === "retry_scheduled"
							? "scheduled"
							: current.phase === "uploading"
								? "processing"
								: "publishing";
					if (
						!currentSubmitted &&
						current.socialPost.status !== expectedPreSubmissionStatus
					) {
						return false;
					}
					if (current.currentClaimId) {
						const active = current.claims.find(
							(claim) => claim.id === current.currentClaimId,
						);
						if (
							active &&
							!active.releasedAt &&
							active.leaseExpiresAt > input.now
						) {
							return false;
						}
						leaseTakenOver = true;
						await tx.publicationClaim.updateMany({
							where: { id: current.currentClaimId, releasedAt: null },
							data: { releasedAt: input.now, accountSlotKey: null },
						});
						await tx.socialPublicationAttempt.updateMany({
							where: { id: current.id, currentClaimId: current.currentClaimId },
							data: { currentClaimId: null },
						});
					}
					const providerBudgetExhausted =
						current.providerCallCount >= input.config.providerCallBudget;
					const phaseDeadlineExceeded =
						current.phase === "processing" || current.phase === "uploading"
							? current.processingDeadline <= input.now
							: currentSubmitted
								? current.reconciliationDeadline <= input.now
								: false;
					const accountUnavailable =
						!currentSubmitted &&
						current.frozenState.socialAccount !== null &&
						current.frozenState.socialAccount.status !== "active";
					if (
						providerBudgetExhausted ||
						phaseDeadlineExceeded ||
						accountUnavailable
					) {
						const code = accountUnavailable
							? "social_account_reconnect_required"
							: providerBudgetExhausted
								? "publication_provider_call_budget_exhausted"
								: current.phase === "processing" ||
										current.phase === "uploading"
									? "publication_processing_deadline_exceeded"
									: "publication_reconciliation_deadline_exceeded";
						const terminalAttempt =
							await tx.socialPublicationAttempt.updateMany({
								where: {
									id: current.id,
									currentClaimId: null,
									phase: current.phase,
								},
								data: {
									phase: currentSubmitted ? "needs_attention" : "failed",
									outcome: currentSubmitted ? "unknown" : "failed",
									failureCode: code,
									failureDisposition: currentSubmitted
										? "attention"
										: "permanent",
									terminalAt: input.now,
								},
							});
						if (terminalAttempt.count !== 1) return false;
						const terminalPost = await tx.socialPost.updateMany({
							where: {
								id: current.socialPostId,
								status: current.socialPost.status,
							},
							data: {
								status: currentSubmitted ? "needs_attention" : "failed",
								errorCode: code,
								errorDisposition: currentSubmitted ? "attention" : "permanent",
								nextAttemptAt: null,
							},
						});
						if (terminalPost.count !== 1) {
							throw new PublicationClaimAdmissionRaceError();
						}
						await emitSocialPostFinished(tx, { socialPostId: current.socialPostId, attemptId: current.id });
						return false;
					}
					await tx.publicationClaim.create({
						data: {
							id: claimId,
							attemptId: current.id,
							claimantId: input.claimantId,
							accountSlotKey: currentSubmitted
								? null
								: candidate.frozenState.socialAccountId,
							heartbeatAt: input.now,
							leaseExpiresAt: new Date(
								input.now.getTime() + input.config.leaseMs,
							),
						},
					});
					const updated = await tx.socialPublicationAttempt.updateMany({
						where: { id: current.id, currentClaimId: null },
						data: {
							currentClaimId: claimId,
							phase:
								current.phase === "retry_scheduled" ? "claimed" : undefined,
						},
					});
					if (updated.count !== 1) {
						await tx.publicationClaim.delete({ where: { id: claimId } });
						return false;
					}
					const projected = await tx.socialPost.updateMany({
						where: {
							id: current.socialPostId,
							status: current.socialPost.status,
						},
						data: {
							status:
								current.phase === "processing" || current.phase === "uploading"
									? "processing"
									: current.phase === "reconciling"
										? "reconciling"
										: "publishing",
						},
					});
					if (projected.count !== 1) {
						await tx.publicationClaim.delete({ where: { id: claimId } });
						if (current.phase === "retry_scheduled") {
							await tx.socialPublicationAttempt.delete({
								where: { id: current.id },
							});
						} else {
							await tx.socialPublicationAttempt.updateMany({
								where: { id: current.id, currentClaimId: claimId },
								data: { currentClaimId: null },
							});
						}
						return false;
					}
					return true;
				});
				if (claimed) {
					owned.push({ attemptId: candidate.id, claimId });
					input.metrics?.observe("social_publication_claims_total", 1, {
						phase: candidate.phase,
					});
					if (leaseTakenOver) {
						input.metrics?.observe(
							"social_publication_lease_takeovers_total",
							1,
							{ phase: candidate.phase },
						);
					}
				}
			} catch (error) {
				if (error instanceof PublicationClaimAdmissionRaceError) continue;
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === "P2002"
				) {
					continue;
				}
				throw error;
			}
		}
		if (candidates.length < pageSize) break;
	}
	return owned;
}

export async function heartbeatSocialPublicationClaim(input: {
	owned: OwnedPublicationAttempt;
	now: Date;
	leaseMs: number;
	metrics?: SocialPublicationMetrics;
}) {
	const updated = await requirePrisma().$transaction(async (tx) => {
		await requireCurrentClaim(tx, input.owned, input.now);
		return tx.publicationClaim.updateMany({
			where: {
				id: input.owned.claimId,
				attemptId: input.owned.attemptId,
				releasedAt: null,
			},
			data: {
				heartbeatAt: input.now,
				leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
			},
		});
	});
	if (updated.count !== 1) throw new PublicationClaimLostError();
	input.metrics?.observe("social_publication_heartbeats_total", 1);
}
