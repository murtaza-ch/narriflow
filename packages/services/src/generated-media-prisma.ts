import { createHash, randomUUID } from "node:crypto";

import type {
	GeneratedMediaJob,
	GenerationUsageReservation,
	Prisma,
	PrismaClient,
} from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	generatedMediaAnalyticsEventSchema,
	resolvePricingTier,
} from "@narriflow/validators";

import { resolveBrandOwner, type BrandActorScope } from "./brand-ownership";
import {
	GeneratedMediaClaimLost,
	GeneratedMediaError,
	type GeneratedMediaAssetDraft,
	type GeneratedMediaClaim,
	type GeneratedMediaJobView,
	type GeneratedMediaModeration,
	type GeneratedMediaStore,
} from "./generated-media";
import { generationUsageAvailability } from "./generation-usage";
import { generatedMediaLatencyBucket } from "./generated-media-analytics";
import { withSerializableTransaction } from "./serializable-transaction";

type PrismaJob = GeneratedMediaJob & {
	insertionCount?: number;
	lastInsertionKind?: string | null;
	lastInsertedAt?: Date | null;
	usage?: GenerationUsageReservation | null;
};

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function sourceIds(value: Prisma.JsonValue): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function moderation(row: PrismaJob): GeneratedMediaModeration {
	const categories = row.moderationCategories
		? sourceIds(row.moderationCategories)
		: undefined;
	return {
		outcome: row.moderationOutcome as GeneratedMediaModeration["outcome"],
		...(row.moderationStage
			? {
					stage: row.moderationStage as NonNullable<
						GeneratedMediaModeration["stage"]
					>,
				}
			: {}),
		...(categories && categories.length > 0 ? { categories } : {}),
	};
}

function toView(row: PrismaJob, replayed = false): GeneratedMediaJobView {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		clipId: row.clipId,
		kind: row.kind as GeneratedMediaJobView["kind"],
		status: row.status as GeneratedMediaJobView["status"],
		provider: row.provider,
		model: row.model,
		promptOrigin: {
			kind: row.promptOriginKind as GeneratedMediaJobView["promptOrigin"]["kind"],
			sourceIds: sourceIds(row.promptOriginSourceIds),
		},
		aspectRatio: row.aspectRatio as GeneratedMediaJobView["aspectRatio"],
		style: row.style as GeneratedMediaJobView["style"],
		durationSec: row.durationSec,
		resultAssetId: row.resultAssetId,
		insertionCount: row.insertionCount ?? 0,
		lastInsertionKind:
			(row.lastInsertionKind as GeneratedMediaJobView["lastInsertionKind"]) ?? null,
		lastInsertedAt: row.lastInsertedAt?.toISOString() ?? null,
		errorCode: row.errorCode,
		moderation: moderation(row),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		replayed,
	};
}

function stagedAsset(row: PrismaJob): GeneratedMediaAssetDraft | null {
	if (
		!row.stagedStorageKey ||
		!row.stagedContentType ||
		row.stagedSizeBytes === null ||
		row.stagedWidth === null ||
		row.stagedHeight === null ||
		!row.stagedFingerprint
	) {
		return null;
	}
	return {
		storageKey: row.stagedStorageKey,
		contentType: row.stagedContentType as GeneratedMediaAssetDraft["contentType"],
		sizeBytes: Number(row.stagedSizeBytes),
		width: row.stagedWidth,
		height: row.stagedHeight,
		durationSec: row.stagedDurationSec,
		hasAudio: row.stagedHasAudio,
		videoCodec: row.stagedVideoCodec,
		audioCodec: row.stagedAudioCodec,
		fingerprint: row.stagedFingerprint,
	};
}

function toClaim(row: PrismaJob, priorStatus: string): GeneratedMediaClaim {
	if (!row.claimId || !row.promptCiphertext || !row.usage) {
		throw new Error("Claimed generated media job is incomplete");
	}
	return {
		jobId: row.id,
		claimId: row.claimId,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		clipId: row.clipId,
		actorUserId: row.actorUserId,
		ownerUserId: row.ownerUserId,
		ownerWorkspaceId: row.ownerWorkspaceId,
		kind: row.kind as GeneratedMediaClaim["kind"],
		provider: row.provider,
		model: row.model,
		promptCiphertext: row.promptCiphertext,
		promptKeyVersion: row.promptKeyVersion,
		idempotencyKey: row.idempotencyKey,
		requestFingerprint: row.requestFingerprint,
		promptFingerprint: row.promptFingerprint,
		promptOrigin: {
			kind: row.promptOriginKind as GeneratedMediaClaim["promptOrigin"]["kind"],
			sourceIds: sourceIds(row.promptOriginSourceIds),
		},
		aspectRatio: row.aspectRatio as GeneratedMediaClaim["aspectRatio"],
		style: row.style as GeneratedMediaClaim["style"],
		durationSec: row.durationSec,
		seed: row.seed,
		title: row.title,
		usageUnits: row.usage.reservedUnits,
		providerReference: row.providerReference,
		resultReference: row.resultReference,
		providerUsageUnits: row.providerUsageUnits,
		moderation: moderation(row),
		attemptCount: row.attemptCount,
		priorStatus: priorStatus as GeneratedMediaClaim["priorStatus"],
		submissionStartedAt: row.submissionStartedAt,
		cancelRequested: row.cancelRequestedAt !== null,
		stagedAsset: stagedAsset(row),
		createdAt: row.createdAt,
	};
}

function isUniqueConstraintError(error: unknown) {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function terminal(status: string) {
	return ["completed", "failed", "rejected", "cancelled"].includes(status);
}

type GeneratedMediaTerminalStatus = "completed" | "failed" | "rejected" | "cancelled";

export function generatedMediaTerminalAnalyticsEventId(jobId: string) {
	const bytes = createHash("sha256")
		.update(`generated-media-terminal:${jobId}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function recordTerminalAnalytics(
	tx: Prisma.TransactionClient,
	input: {
		job: PrismaJob;
		status: GeneratedMediaTerminalStatus;
		moderationOutcome: GeneratedMediaModeration["outcome"];
		usageUnits: number;
		now: Date;
	},
) {
	const workspace = await tx.workspace.findUnique({
		where: { id: input.job.workspaceId },
		select: { pricingTier: true },
	});
	if (!workspace) throw new Error("Generated media workspace is unavailable");
	const outcome = {
		completed: "succeeded",
		failed: "failed",
		rejected: "rejected",
		cancelled: "cancelled",
	}[input.status] as "succeeded" | "failed" | "rejected" | "cancelled";
	const event = generatedMediaAnalyticsEventSchema.parse({
		type: "generated_asset_completed",
		projectId: input.job.projectId,
		clipId: input.job.clipId,
		metadata: {
			kind: input.job.kind,
			providerAlias: input.job.provider,
			modelAlias: input.job.model,
			status: input.status,
			latencyBucket: generatedMediaLatencyBucket(
				Math.max(0, input.now.getTime() - input.job.createdAt.getTime()),
			),
			retryCount: Math.max(0, input.job.attemptCount - 1),
			moderationOutcome: input.moderationOutcome,
			usageUnits: input.usageUnits,
			outcome,
			planTier: resolvePricingTier(workspace.pricingTier),
		},
	});
	await tx.projectAnalyticsEvent.create({
		data: {
			id: generatedMediaTerminalAnalyticsEventId(input.job.id),
			projectId: event.projectId,
			clipId: event.clipId ?? null,
			type: event.type,
			metadata: event.metadata as Prisma.InputJsonValue,
			createdAt: input.now,
		},
	});
}

export function createPrismaGeneratedMediaStore(
	prisma: PrismaClient = requirePrisma(),
): GeneratedMediaStore {
	async function readReplay(
		client: Pick<Prisma.TransactionClient, "generatedMediaJob">,
		scope: BrandActorScope,
		idempotencyKey: string,
		requestFingerprint: string,
	) {
		const existing = await client.generatedMediaJob.findUnique({
			where: {
				workspaceId_idempotencyKey: {
					workspaceId: scope.workspaceId,
					idempotencyKey,
				},
			},
		});
		if (!existing) return null;
		if (existing.requestFingerprint !== requestFingerprint) {
			throw new GeneratedMediaError("generated_media_idempotency_conflict");
		}
		return { job: toView(existing as PrismaJob, true), replayed: true };
	}

	async function assertClaim(
		tx: Prisma.TransactionClient,
		claim: GeneratedMediaClaim,
	) {
		const job = await tx.generatedMediaJob.findFirst({
			where: { id: claim.jobId, claimId: claim.claimId, status: "running" },
			include: { usage: true },
		});
		if (!job) throw new GeneratedMediaClaimLost();
		return job as PrismaJob;
	}

	return {
		terminalAnalyticsDelivery: "transactional",
		async reserve(input) {
			const replay = await readReplay(
				prisma,
				input.scope,
				input.request.idempotencyKey,
				input.requestFingerprint,
			);
			if (replay) return replay;
			try {
				return await withSerializableTransaction(prisma, async (tx) => {
					const project = await tx.project.findFirst({
						where: {
							id: input.request.projectId,
							workspaceId: input.scope.workspaceId,
						},
						select: { id: true },
					});
					if (!project) throw new GeneratedMediaError("generated_media_not_found");
					if (input.request.clipId) {
						const clip = await tx.clip.findFirst({
							where: {
								id: input.request.clipId,
								projectId: input.request.projectId,
							},
							select: { id: true },
						});
						if (!clip) throw new GeneratedMediaError("generated_media_not_found");
					}
					await tx.$queryRaw`
						SELECT pg_advisory_xact_lock(
							hashtextextended(${`${input.scope.workspaceId}:${input.request.kind}:generated-media-usage`}, 0)
						) IS NULL AS "locked"
					`;
					const lockedReplay = await readReplay(
						tx,
						input.scope,
						input.request.idempotencyKey,
						input.requestFingerprint,
					);
					if (lockedReplay) return lockedReplay;
					const allowanceWhere = {
						workspaceId: input.scope.workspaceId,
						kind: input.request.kind,
						...(input.usageWindow.allowance.startsAt ||
						input.usageWindow.allowance.endsAt
							? {
								createdAt: {
									...(input.usageWindow.allowance.startsAt
										? { gte: input.usageWindow.allowance.startsAt }
										: {}),
									...(input.usageWindow.allowance.endsAt
										? { lt: input.usageWindow.allowance.endsAt }
										: {}),
								},
							}
							: {}),
					} satisfies Prisma.GenerationUsageReservationWhereInput;
					const [reserved, finalized, admitted] = await Promise.all([
						tx.generationUsageReservation.aggregate({
							where: { ...allowanceWhere, status: "reserved" },
							_sum: { reservedUnits: true },
						}),
						tx.generationUsageReservation.aggregate({
							where: { ...allowanceWhere, status: "finalized" },
							_sum: { finalizedUnits: true },
						}),
						tx.generationUsageReservation.aggregate({
							where: {
								workspaceId: input.scope.workspaceId,
								kind: input.request.kind,
								createdAt: {
									gte: input.usageWindow.dailyAbuse.startsAt!,
									lt: input.usageWindow.dailyAbuse.endsAt!,
								},
							},
							_sum: { reservedUnits: true },
						}),
					]);
					const committedUnits =
						(reserved._sum.reservedUnits ?? 0) +
						(finalized._sum.finalizedUnits ?? 0);
					if (
						committedUnits + input.usageUnits >
							input.usageWindow.allowance.limitUnits ||
						(admitted._sum.reservedUnits ?? 0) + input.usageUnits >
							input.usageWindow.dailyAbuse.limitUnits
					) {
						throw new GeneratedMediaError("generated_media_usage_exhausted");
					}
					const owner = resolveBrandOwner(input.scope);
					const created = await tx.generatedMediaJob.create({
						data: {
							workspaceId: input.scope.workspaceId,
							projectId: input.request.projectId,
							clipId: input.request.clipId,
							actorUserId: input.scope.actorUserId,
							ownerUserId: owner.userId,
							ownerWorkspaceId: owner.workspaceId,
							kind: input.request.kind,
							idempotencyKey: input.request.idempotencyKey,
							requestFingerprint: input.requestFingerprint,
							provider: input.provider,
							model: input.model,
							promptCiphertext: input.promptCiphertext,
							promptFingerprint: input.promptFingerprint,
							promptKeyVersion: input.promptKeyVersion,
							promptOriginKind: input.request.promptOrigin.kind,
							promptOriginSourceIds: [
								...input.request.promptOrigin.sourceIds,
							] as Prisma.InputJsonValue,
							aspectRatio: input.request.aspectRatio,
							style: input.request.style,
							durationSec: input.request.durationSec,
							seed: input.request.seed,
							title: input.request.title,
							nextAttemptAt: input.now,
							createdAt: input.now,
							updatedAt: input.now,
							usage: {
								create: {
									workspaceId: input.scope.workspaceId,
									kind: input.request.kind,
									reservedUnits: input.usageUnits,
									usagePolicy: input.usageWindow.policy,
									allowancePeriod: input.usageWindow.allowance.period,
									allowanceLimitUnits:
										input.usageWindow.allowance.limitUnits,
									allowanceStartedAt:
										input.usageWindow.allowance.startsAt,
									allowanceEndsAt: input.usageWindow.allowance.endsAt,
									dailyAbuseLimitUnits:
										input.usageWindow.dailyAbuse.limitUnits,
									dailyAbuseStartedAt:
										input.usageWindow.dailyAbuse.startsAt!,
									dailyAbuseEndsAt: input.usageWindow.dailyAbuse.endsAt!,
									createdAt: input.now,
									updatedAt: input.now,
								},
							},
						},
					});
					return { job: toView(created as PrismaJob), replayed: false };
				});
			} catch (error) {
				if (!isUniqueConstraintError(error)) throw error;
				const raced = await readReplay(
					prisma,
					input.scope,
					input.request.idempotencyKey,
					input.requestFingerprint,
				);
				if (!raced) throw error;
				return raced;
			}
		},
		async usageSummary(scope, windows) {
			const summarize = async (kind: "image" | "video") => {
				const window = windows[kind];
				const select = {
					status: true,
					reservedUnits: true,
					finalizedUnits: true,
					releasedUnits: true,
				} as const;
				const [allowanceRows, dailyRows] = await Promise.all([
					prisma.generationUsageReservation.findMany({
						where: {
							workspaceId: scope.workspaceId,
							kind,
							...(window.allowance.startsAt || window.allowance.endsAt
								? {
									createdAt: {
										...(window.allowance.startsAt
											? { gte: window.allowance.startsAt }
											: {}),
										...(window.allowance.endsAt
											? { lt: window.allowance.endsAt }
											: {}),
									},
								}
								: {}),
						},
						select,
					}),
					prisma.generationUsageReservation.findMany({
						where: {
							workspaceId: scope.workspaceId,
							kind,
							createdAt: {
								gte: window.dailyAbuse.startsAt!,
								lt: window.dailyAbuse.endsAt!,
							},
						},
						select,
					}),
				]);
				return generationUsageAvailability(window, {
					admittedUnits: dailyRows.reduce(
						(sum, row) => sum + row.reservedUnits,
						0,
					),
					committedUnits: allowanceRows.reduce(
						(sum, row) =>
							sum +
							(row.status === "reserved"
								? row.reservedUnits
								: row.status === "finalized"
									? row.finalizedUnits
									: 0),
						0,
					),
					reservedUnits: allowanceRows
						.filter((row) => row.status === "reserved")
						.reduce((sum, row) => sum + row.reservedUnits, 0),
					finalizedUnits: allowanceRows
						.filter((row) => row.status === "finalized")
						.reduce((sum, row) => sum + row.finalizedUnits, 0),
					releasedUnits: allowanceRows
						.filter((row) => row.status === "released")
						.reduce((sum, row) => sum + row.releasedUnits, 0),
				});
			};
			const [image, video] = await Promise.all([
				summarize("image"),
				summarize("video"),
			]);
			return { image, video };
		},
		async get(scope, jobId) {
			const job = await prisma.generatedMediaJob.findFirst({
				where: { id: jobId, workspaceId: scope.workspaceId },
			});
			return job ? toView(job as PrismaJob) : null;
		},
		async list(scope, projectId) {
			const rows = await prisma.generatedMediaJob.findMany({
				where: { workspaceId: scope.workspaceId, projectId },
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			});
			return rows.map((row) => toView(row as PrismaJob));
		},
		async requestCancellation(input) {
			return withSerializableTransaction(prisma, async (tx) => {
				const job = await tx.generatedMediaJob.findFirst({
					where: { id: input.jobId, workspaceId: input.scope.workspaceId },
					include: { usage: true },
				});
				if (!job) return null;
				if (terminal(job.status)) return toView(job as PrismaJob);
				const queued = job.status === "queued" && !job.submissionStartedAt;
				const updated = await tx.generatedMediaJob.update({
					where: { id: job.id },
					data: queued
						? {
								status: "cancelled",
								errorCode: "generated_media_cancelled",
								cancelRequestedAt: input.now,
								promptDeleteAfter: new Date(
									input.now.getTime() + input.promptRetentionMs,
								),
								completedAt: input.now,
								updatedAt: input.now,
							}
						: {
								cancelRequestedAt: input.now,
								nextPollAt: job.providerReference ? input.now : job.nextPollAt,
								updatedAt: input.now,
							},
				});
				if (queued && job.usage?.status === "reserved") {
					await tx.generationUsageReservation.update({
						where: { jobId: job.id },
						data: {
							status: "released",
							releasedUnits: job.usage.reservedUnits,
							releasedAt: input.now,
							updatedAt: input.now,
						},
					});
				}
				if (queued) {
					await recordTerminalAnalytics(tx, {
						job: job as PrismaJob,
						status: "cancelled",
						moderationOutcome:
							job.moderationOutcome as GeneratedMediaModeration["outcome"],
						usageUnits: 0,
						now: input.now,
					});
				}
				return toView(updated as PrismaJob);
			});
		},
		async claimNext(input) {
			return withSerializableTransaction(prisma, async (tx) => {
				const phases: Prisma.GeneratedMediaJobWhereInput[] = [
					{
						status: "waiting",
						providerReference: { not: null },
						nextPollAt: { lte: input.now },
					},
					{ status: "running", claimExpiresAt: { lte: input.now } },
					{ status: "queued", nextAttemptAt: { lte: input.now } },
				];
				for (const phase of phases) {
					const eligibility: Prisma.GeneratedMediaJobWhereInput = {
						kind: { in: [...input.enabledKinds] },
						...phase,
					};
					let cursor: { id: string } | undefined;
					for (;;) {
						const candidates = await tx.generatedMediaJob.findMany({
							where: eligibility,
							orderBy: [{ createdAt: "asc" }, { id: "asc" }],
							take: 25,
							...(cursor ? { cursor, skip: 1 } : {}),
						});
						if (candidates.length === 0) break;
						for (const candidate of candidates) {
							if (candidate.status === "queued") {
								const active = await tx.generatedMediaJob.count({
									where: {
										workspaceId: candidate.workspaceId,
										kind: candidate.kind,
										OR: [
											{ status: "waiting" },
											{
												status: "running",
												claimExpiresAt: { gt: input.now },
											},
										],
									},
								});
								const kind = candidate.kind as "image" | "video";
								if (active >= (input.maxConcurrency[kind] ?? 0)) continue;
							}
							const claimId = randomUUID();
							const claimed = await tx.generatedMediaJob.updateMany({
								where: { id: candidate.id, AND: [eligibility] },
								data: {
									status: "running",
									claimId,
									claimOwner: input.workerId,
									claimExpiresAt: new Date(
										input.now.getTime() + input.leaseMs,
									),
									attemptCount: { increment: 1 },
									updatedAt: input.now,
								},
							});
							if (claimed.count !== 1) continue;
							const row = await tx.generatedMediaJob.findUniqueOrThrow({
								where: { id: candidate.id },
								include: { usage: true },
							});
							return toClaim(row as PrismaJob, candidate.status);
						}
						if (candidates.length < 25) break;
						cursor = { id: candidates[candidates.length - 1]!.id };
					}
				}
				return null;
			});
		},
		async beginSubmission(input) {
			return withSerializableTransaction(prisma, async (tx) => {
				const job = await assertClaim(tx, input.claim);
				if (job.cancelRequestedAt) {
					await tx.generatedMediaJob.update({
						where: { id: job.id },
						data: {
							status: "cancelled",
							errorCode: "generated_media_cancelled",
							promptDeleteAfter: new Date(
								input.now.getTime() + input.promptRetentionMs,
							),
							completedAt: input.now,
							claimId: null,
							claimOwner: null,
							claimExpiresAt: null,
							updatedAt: input.now,
						},
					});
					if (job.usage?.status === "reserved") {
						await tx.generationUsageReservation.update({
							where: { jobId: job.id },
							data: {
								status: "released",
								releasedUnits: job.usage.reservedUnits,
								releasedAt: input.now,
								updatedAt: input.now,
							},
						});
					}
					await recordTerminalAnalytics(tx, {
						job,
						status: "cancelled",
						moderationOutcome:
							job.moderationOutcome as GeneratedMediaModeration["outcome"],
						usageUnits: 0,
						now: input.now,
					});
					return "cancelled" as const;
				}
				const started = await tx.generatedMediaJob.updateMany({
					where: {
						id: input.claim.jobId,
						claimId: input.claim.claimId,
						status: "running",
						cancelRequestedAt: null,
					},
					data: { submissionStartedAt: input.now, updatedAt: input.now },
				});
				if (started.count !== 1) throw new GeneratedMediaClaimLost();
				return "started" as const;
			});
		},
		async recordProviderResult(input) {
			const result = await prisma.generatedMediaJob.updateMany({
				where: {
					id: input.claim.jobId,
					claimId: input.claim.claimId,
					status: "running",
				},
				data: {
					providerReference: input.providerReference,
					resultReference: input.resultReference,
					providerUsageUnits: input.usageUnits,
					moderationOutcome: input.moderation.outcome,
					moderationStage: input.moderation.stage,
					moderationCategories: input.moderation.categories
						? ([...input.moderation.categories] as Prisma.InputJsonValue)
						: undefined,
					errorCode: null,
					updatedAt: input.now,
				},
			});
			if (result.count !== 1) throw new GeneratedMediaClaimLost();
		},
		async markWaiting(input) {
			const result = await prisma.generatedMediaJob.updateMany({
				where: {
					id: input.claim.jobId,
					claimId: input.claim.claimId,
					status: "running",
				},
				data: {
					status: "waiting",
					providerReference:
						input.providerReference ?? input.claim.providerReference,
					nextPollAt: input.nextPollAt,
					errorCode: input.errorCode ?? null,
					...(input.moderation
						? {
								moderationOutcome: input.moderation.outcome,
								moderationStage: input.moderation.stage,
								moderationCategories: input.moderation.categories
									? ([...input.moderation.categories] as Prisma.InputJsonValue)
									: undefined,
							}
						: {}),
					claimId: null,
					claimOwner: null,
					claimExpiresAt: null,
					updatedAt: input.now,
				},
			});
			if (result.count !== 1) throw new GeneratedMediaClaimLost();
		},
		async markReconciliationRequired(input) {
			const result = await prisma.generatedMediaJob.updateMany({
				where: {
					id: input.claim.jobId,
					claimId: input.claim.claimId,
					status: "running",
				},
				data: {
					status: "reconciliation_required",
					providerReference: input.providerReference,
					resultReference: input.resultReference,
					providerUsageUnits: input.usageUnits,
					...(input.moderation
						? {
								moderationOutcome: input.moderation.outcome,
								moderationStage: input.moderation.stage,
								moderationCategories: input.moderation.categories
									? ([...input.moderation.categories] as Prisma.InputJsonValue)
									: undefined,
							}
						: {}),
					nextPollAt: null,
					errorCode: input.errorCode,
					promptDeleteAfter: new Date(
						input.now.getTime() + input.promptRetentionMs,
					),
					claimId: null,
					claimOwner: null,
					claimExpiresAt: null,
					updatedAt: input.now,
				},
			});
			if (result.count !== 1) throw new GeneratedMediaClaimLost();
		},
		async markRetry(input) {
			const result = await prisma.generatedMediaJob.updateMany({
				where: {
					id: input.claim.jobId,
					claimId: input.claim.claimId,
					status: "running",
				},
				data: {
					status: "queued",
					nextAttemptAt: input.nextAttemptAt,
					errorCode: input.errorCode,
					...(!input.claim.providerReference && !input.claim.resultReference
						? { submissionStartedAt: null }
						: {}),
					claimId: null,
					claimOwner: null,
					claimExpiresAt: null,
					updatedAt: input.now,
				},
			});
			if (result.count !== 1) throw new GeneratedMediaClaimLost();
		},
		async markTerminal(input) {
			await withSerializableTransaction(prisma, async (tx) => {
				const job = await assertClaim(tx, input.claim);
				await tx.generatedMediaJob.update({
					where: { id: job.id },
					data: {
						status: input.status,
						errorCode: input.errorCode,
						...(input.moderation
							? {
									moderationOutcome: input.moderation.outcome,
									moderationStage: input.moderation.stage,
									moderationCategories: input.moderation.categories
										? ([...input.moderation.categories] as Prisma.InputJsonValue)
										: undefined,
								}
							: {}),
						promptDeleteAfter: new Date(
							input.now.getTime() + input.promptRetentionMs,
						),
						completedAt: input.now,
						claimId: null,
						claimOwner: null,
						claimExpiresAt: null,
						updatedAt: input.now,
					},
				});
				if (job.usage?.status === "reserved") {
					await tx.generationUsageReservation.update({
						where: { jobId: job.id },
						data: {
							status: "released",
							releasedUnits: job.usage.reservedUnits,
							releasedAt: input.now,
							updatedAt: input.now,
						},
					});
				}
				await recordTerminalAnalytics(tx, {
					job,
					status: input.status,
					moderationOutcome:
						input.moderation?.outcome ??
						(job.moderationOutcome as GeneratedMediaModeration["outcome"]),
					usageUnits: 0,
					now: input.now,
				});
			});
		},
		async stageAsset(input) {
			const result = await prisma.generatedMediaJob.updateMany({
				where: {
					id: input.claim.jobId,
					claimId: input.claim.claimId,
					status: "running",
				},
				data: {
					stagedStorageKey: input.asset.storageKey,
					stagedContentType: input.asset.contentType,
					stagedSizeBytes: BigInt(input.asset.sizeBytes),
					stagedWidth: input.asset.width,
					stagedHeight: input.asset.height,
					stagedDurationSec: input.asset.durationSec,
					stagedHasAudio: input.asset.hasAudio,
					stagedVideoCodec: input.asset.videoCodec,
					stagedAudioCodec: input.asset.audioCodec,
					stagedFingerprint: input.asset.fingerprint,
					updatedAt: input.now,
				},
			});
			if (result.count !== 1) throw new GeneratedMediaClaimLost();
		},
		async publishAsset(input) {
			return withSerializableTransaction(prisma, async (tx) => {
				const job = await assertClaim(tx, input.claim);
				const staged = stagedAsset(job);
				if (!staged || !job.usage || job.providerUsageUnits === null) {
					throw new Error("Generated media asset is not ready to publish");
				}
				if (
					job.providerUsageUnits < 0 ||
					job.providerUsageUnits > job.usage.reservedUnits
				) {
					throw new Error("Generated media usage exceeds its reservation");
				}
				const ownerWhere = job.ownerWorkspaceId
					? { workspaceId: job.ownerWorkspaceId }
					: { userId: job.ownerUserId! };
				let asset = await tx.visualAsset.findFirst({
					where: {
						...ownerWhere,
						fingerprint: staged.fingerprint,
						provenance: { in: ["uploaded", "generated"] },
					},
				});
				const replayed = Boolean(asset);
				if (asset?.deletedAt) {
					asset = await tx.visualAsset.update({
						where: { id: asset.id },
						data: { deletedAt: null },
					});
				}
				asset ??= await tx.visualAsset.create({
					data: {
						userId: job.ownerUserId,
						workspaceId: job.ownerWorkspaceId,
						createdByUserId: job.actorUserId,
						title: job.title ?? `Generated ${job.kind}`,
						kind: job.kind as "image" | "video",
						storageKey: staged.storageKey,
						contentType: staged.contentType,
						sizeBytes: BigInt(staged.sizeBytes),
						width: staged.width,
						height: staged.height,
						durationSec: staged.durationSec,
						hasAudio: staged.hasAudio,
						videoCodec: staged.videoCodec,
						audioCodec: staged.audioCodec,
						fingerprint: staged.fingerprint,
						provenance: "generated",
					},
				});
				await tx.generationUsageReservation.update({
					where: { jobId: job.id },
					data: {
						status: "finalized",
						finalizedUnits: job.providerUsageUnits,
						finalizedAt: input.now,
						updatedAt: input.now,
					},
				});
				await tx.generatedMediaJob.update({
					where: { id: job.id },
					data: {
						status: "completed",
						resultAssetId: asset.id,
						resultReference: null,
						errorCode: null,
						promptDeleteAfter: new Date(
							input.now.getTime() + input.promptRetentionMs,
						),
						completedAt: input.now,
						claimId: null,
						claimOwner: null,
						claimExpiresAt: null,
						...(asset.storageKey !== staged.storageKey
							? {
									stagedStorageKey: null,
									stagedContentType: null,
									stagedSizeBytes: null,
									stagedWidth: null,
									stagedHeight: null,
									stagedDurationSec: null,
									stagedHasAudio: null,
									stagedVideoCodec: null,
									stagedAudioCodec: null,
									// Keep the verified output fingerprint as the durable
									// identity binding when publication reuses an existing
									// uploaded or generated asset.
									stagedFingerprint: staged.fingerprint,
								}
							: {}),
						updatedAt: input.now,
					},
				});
				await recordTerminalAnalytics(tx, {
					job,
					status: "completed",
					moderationOutcome:
						job.moderationOutcome as GeneratedMediaModeration["outcome"],
					usageUnits: job.providerUsageUnits,
					now: input.now,
				});
				return { assetId: asset.id, replayed };
			});
		},
		async recordInsertion(input) {
			const changed = await prisma.$executeRaw`
				UPDATE "GeneratedMediaJob"
				SET "insertionCount" = "insertionCount" + 1,
				    "lastInsertionKind" = ${input.kind},
				    "lastInsertedAt" = ${input.now},
				    "updatedAt" = ${input.now}
				WHERE "id" = ${input.jobId}::uuid
				  AND "workspaceId" = ${input.scope.workspaceId}::uuid
				  AND "status" = 'completed'
				  AND "resultAssetId" IS NOT NULL
			`;
			if (changed !== 1) return null;
			const row = await prisma.generatedMediaJob.findUnique({
				where: { id: input.jobId },
			});
			return row ? toView(row as PrismaJob) : null;
		},
		async purgeExpiredPrompts(now, limit) {
			const candidates = await prisma.generatedMediaJob.findMany({
				where: { promptCiphertext: { not: null }, promptDeleteAfter: { lte: now } },
				select: { id: true },
				orderBy: { promptDeleteAfter: "asc" },
				take: Math.max(1, Math.min(1000, limit)),
			});
			if (candidates.length === 0) return 0;
			const result = await prisma.generatedMediaJob.updateMany({
				where: { id: { in: candidates.map((candidate) => candidate.id) } },
				data: { promptCiphertext: null },
			});
			return result.count;
		},
		async referencedStorageKeys(prefix) {
			const [rows, assets] = await Promise.all([
				prisma.generatedMediaJob.findMany({
					where: {
						OR: [
							{ stagedStorageKey: { startsWith: prefix } },
							{ resultReference: { startsWith: prefix } },
						],
					},
					select: { stagedStorageKey: true, resultReference: true },
				}),
				prisma.visualAsset.findMany({
					where: { storageKey: { startsWith: prefix } },
					select: { storageKey: true },
				}),
			]);
			return new Set(
				[
					...rows.flatMap((row) =>
						[row.stagedStorageKey, row.resultReference].filter(
							(value): value is string => Boolean(value),
						),
					),
					...assets.map((asset) => asset.storageKey),
				],
			);
		},
	};
}
