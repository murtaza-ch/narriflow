import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { clipAspectRatioFromDb, clipAspectRatioToDb } from "@narriflow/validators";
import { clipExportService } from "./clip-export.service";
import { accessibleProjectWhere } from "./project-access";
import { brandOwnerWhere } from "./brand-ownership";
import { assistedSocialCopyService } from "./assisted-social-copy-runtime";
import { readSocialPublishingOptionsForAccount } from "./social-publishing-options";
import { isSocialProviderPublishingEnabled, socialPublicationCapabilityVersion } from "./social-publication-config";
import { reviewApprovalGate } from "./review-approval-gate.prisma";
import { workspaceService } from "./workspace.service";
import { createSocialPublicationScheduling, PublicationIntentConflictError, PublicationIntentStateError, type PublicationIntent, type PublicationSchedulingStore } from "./social-publication-scheduling";

const publicationIntentInclude = {
	frozenState: true,
} satisfies Prisma.SocialPostInclude;

type PublicationIntentRow = Prisma.SocialPostGetPayload<{
	include: typeof publicationIntentInclude;
}>;

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function toPublicationIntent(row: PublicationIntentRow): PublicationIntent {
	const frozen = row.frozenState;
	if (
		!row.workspaceId ||
		!row.createdByUserId ||
		!row.clipId ||
		!row.clientIdempotencyKey ||
		!row.immutableRequestHash ||
		!frozen
	) {
		throw new PublicationIntentStateError(
			"publication_intent_incomplete",
			"The Social Post does not contain a complete frozen publication intent",
		);
	}
	const status = row.status;
	return {
		id: row.id,
		createdByUserId: row.createdByUserId,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		clipId: row.clipId,
		clientIdempotencyKey: row.clientIdempotencyKey,
		immutableRequestHash: row.immutableRequestHash,
		status,
		submissionEligible:
			status === "scheduled" &&
			frozen.storageKey !== null &&
			frozen.sizeBytes !== null &&
			frozen.durationSec !== null,
		reviewApprovalOverrideId: row.reviewApprovalOverrideId,
		frozen: {
			clipExportId: frozen.clipExportId,
			deliveryMode: frozen.deliveryMode,
			clipExportVariantId: frozen.clipExportVariantId,
			editorRevision: frozen.editorRevision,
			exportFingerprint: frozen.exportFingerprint,
			storageKey: frozen.storageKey,
			sizeBytes: frozen.sizeBytes === null ? null : Number(frozen.sizeBytes),
			durationSec: frozen.durationSec,
			aspectRatio: clipAspectRatioFromDb[frozen.aspectRatio],
			caption: frozen.caption,
			providerSettings:
				frozen.providerSettings &&
				typeof frozen.providerSettings === "object" &&
				!Array.isArray(frozen.providerSettings)
					? (frozen.providerSettings as Prisma.JsonObject)
					: {},
			socialAccountId: frozen.socialAccountId,
			platform: frozen.platform,
			capabilityVersion: frozen.capabilityVersion,
			scheduledFor: frozen.scheduledFor,
		},
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

async function readIntentByKey(
	workspaceId: string,
	clientIdempotencyKey: string,
) {
	return requirePrisma().socialPost.findUnique({
		where: {
			workspaceId_clientIdempotencyKey: {
				workspaceId,
				clientIdempotencyKey,
			},
		},
		include: publicationIntentInclude,
	});
}

/** The rows the Social Post store writes when it freezes an intent. */
function frozenStateData(candidate: PublicationIntent) {
	return {
		clipExportId: candidate.frozen.clipExportId,
		clipExportVariantId: candidate.frozen.clipExportVariantId,
		socialAccountId: candidate.frozen.socialAccountId,
		platform: candidate.frozen.platform,
		editorRevision: candidate.frozen.editorRevision,
		exportFingerprint: candidate.frozen.exportFingerprint,
		storageKey: candidate.frozen.storageKey,
		sizeBytes: candidate.frozen.sizeBytes,
		durationSec: candidate.frozen.durationSec,
		aspectRatio: clipAspectRatioToDb[candidate.frozen.aspectRatio],
		caption: candidate.frozen.caption,
		deliveryMode: candidate.frozen.deliveryMode ?? "direct",
		providerSettings: candidate.frozen.providerSettings,
		capabilityVersion: candidate.frozen.capabilityVersion,
		scheduledFor: candidate.frozen.scheduledFor,
		mediaReadyAt: candidate.submissionEligible ? candidate.createdAt : null,
	};
}

/** A draft is a Proposal waiting for acceptance, not an admitted intent. Its
 * key belongs to the proposal, so only that proposal's acceptance may use it. */
const isAdmitted = (row: { status: string }) => row.status !== "draft";

export const prismaPublicationSchedulingStore: PublicationSchedulingStore = {
	async readByKey(workspaceId, clientIdempotencyKey) {
		const row = await readIntentByKey(workspaceId, clientIdempotencyKey);
		return row && isAdmitted(row) ? toPublicationIntent(row) : null;
	},

	async open(input) {
		const existing = await readIntentByKey(
			input.workspaceId,
			input.clientIdempotencyKey,
		);
		if (existing && isAdmitted(existing)) {
			if (existing.immutableRequestHash !== input.immutableRequestHash) {
				throw new PublicationIntentConflictError();
			}
			return toPublicationIntent(existing);
		}
		if (existing && existing.id !== input.proposalId) {
			throw new PublicationIntentConflictError();
		}

		try {
			const candidate = await input.create();
			const created = await requirePrisma().$transaction(
				async (tx) => {
					const replay = await tx.socialPost.findUnique({
						where: {
							workspaceId_clientIdempotencyKey: {
								workspaceId: input.workspaceId,
								clientIdempotencyKey: input.clientIdempotencyKey,
							},
						},
						include: publicationIntentInclude,
					});
					if (replay && isAdmitted(replay)) {
						if (replay.immutableRequestHash !== input.immutableRequestHash) {
							throw new PublicationIntentConflictError();
						}
						return replay;
					}
					if (replay && replay.id !== input.proposalId) {
						throw new PublicationIntentConflictError();
					}

					let granted: { revision: number } | null = null;
					if (input.slotQueue) {
						// Lock the account, then read what it occupies and choose the slot, so
						// a second admission waits here and sees this post once it commits.
						// NO KEY UPDATE still lets this transaction's own foreign keys to the
						// account row (KEY SHARE) through.
						await tx.$queryRaw`SELECT "id" FROM "SocialAccount" WHERE "id" = ${input.slotQueue.accountId}::uuid FOR NO KEY UPDATE`;
						// A grant's caps are counted under this same lock, so two admissions can't both take the last place.
						if (input.slotQueue.grant) granted = await input.slotQueue.grant.admit(tx);
						const taken = await tx.socialPost.findMany({
							where: {
								socialAccountId: input.slotQueue.accountId,
								scheduledFor: { gt: new Date() },
								status: { notIn: ["draft", "cancelled", "failed"] },
							},
							select: { scheduledFor: true },
						});
						const slot = input.slotQueue.pick(
							new Set(taken.flatMap((post) => (post.scheduledFor ? [post.scheduledFor.getTime()] : []))),
							new Date(),
						);
						if (!slot) {
							throw new PublicationIntentStateError(
								"posting_schedule_exhausted",
								"The posting schedule has no free slot left",
							);
						}
						candidate.frozen.scheduledFor = slot;
					}

					let row: PublicationIntentRow;
					if (input.proposalId) {
						// Accepting converts the proposal's own Social Post, so its ID stays the
						// identity everyone was given. The caption read before the lock must still
						// be the draft's, or a person's edit made meanwhile would be lost.
						const converted = await tx.socialPost.updateMany({
							where: { id: input.proposalId, workspaceId: input.workspaceId, status: "draft", caption: candidate.frozen.caption },
							data: {
								status: candidate.status,
								clientIdempotencyKey: candidate.clientIdempotencyKey,
								immutableRequestHash: candidate.immutableRequestHash,
								deliveryMode: candidate.frozen.deliveryMode ?? "direct",
								aspectRatio: clipAspectRatioToDb[candidate.frozen.aspectRatio],
								scheduledFor: candidate.frozen.scheduledFor,
								metadata: candidate.frozen.providerSettings,
								reviewApprovalOverrideId: candidate.reviewApprovalOverrideId,
								...(granted && input.slotQueue?.grant ? { standingGrantId: input.slotQueue.grant.id, standingGrantRevision: granted.revision } : {}),
							},
						});
						if (converted.count === 0) {
							const current = await tx.socialPost.findFirst({
								where: { id: input.proposalId, workspaceId: input.workspaceId },
								select: { status: true },
							});
							throw current?.status === "draft"
								? new PublicationIntentStateError("social_proposal_changed", "The caption changed while it was being accepted. Review it and accept again")
								: new PublicationIntentStateError("social_proposal_unavailable", "This proposal was already accepted or rejected");
						}
						await tx.frozenPublicationState.create({ data: { socialPostId: input.proposalId, ...frozenStateData(candidate) } });
						await tx.socialPostProposal.update({
							where: { socialPostId: input.proposalId },
							data: { acceptedAt: new Date(), acceptedByUserId: candidate.createdByUserId },
						});
						row = await tx.socialPost.findUniqueOrThrow({ where: { id: input.proposalId }, include: publicationIntentInclude });
					} else {
						row = await tx.socialPost.create({
							data: {
								id: candidate.id,
								workspaceId: candidate.workspaceId,
								createdByUserId: candidate.createdByUserId,
								projectId: candidate.projectId,
								clipId: candidate.clipId,
								socialAccountId: candidate.frozen.socialAccountId,
								platform: candidate.frozen.platform,
								status: candidate.status,
								clientIdempotencyKey: candidate.clientIdempotencyKey,
								immutableRequestHash: candidate.immutableRequestHash,
								caption: candidate.frozen.caption,
								deliveryMode: candidate.frozen.deliveryMode ?? "direct",
								aspectRatio: clipAspectRatioToDb[candidate.frozen.aspectRatio],
								scheduledFor: candidate.frozen.scheduledFor,
								metadata: candidate.frozen.providerSettings,
								reviewApprovalOverrideId: candidate.reviewApprovalOverrideId,
								frozenState: { create: frozenStateData(candidate) },
							},
							include: publicationIntentInclude,
						});
					}
					await tx.projectAnalyticsEvent.create({
						data: {
							projectId: candidate.projectId,
							clipId: candidate.clipId,
							type: "social_scheduled",
							platform: candidate.frozen.platform,
							metadata: {
								socialPostId: candidate.id,
								preparation: candidate.status === "preparing_video",
							},
						},
					});
					if (candidate.reviewApprovalOverrideId) {
						await tx.projectAnalyticsEvent.create({
							data: {
								projectId: candidate.projectId,
								clipId: candidate.clipId,
								type: "review_approval_overridden",
								platform: candidate.frozen.platform,
								metadata: {
									socialPostId: candidate.id,
									reviewApprovalOverrideId: candidate.reviewApprovalOverrideId,
									exportId: candidate.frozen.clipExportId,
								},
							},
						});
					}
					return row;
				},
				// A queued admission waits on the account lock and must then see the
				// post that held it. A serializable snapshot, taken before the wait,
				// would not, so it reads committed rows instead.
				{
					isolationLevel: input.slotQueue
						? Prisma.TransactionIsolationLevel.ReadCommitted
						: Prisma.TransactionIsolationLevel.Serializable,
				},
			);
			return toPublicationIntent(created);
		} catch (error) {
			// Another admission can commit while this request reads mutable facts.
			// Resolve its durable identity before reporting any rejection or loss.
			const replay = await readIntentByKey(input.workspaceId, input.clientIdempotencyKey);
			if (replay && isAdmitted(replay)) {
				if (replay.immutableRequestHash !== input.immutableRequestHash) throw new PublicationIntentConflictError();
				return toPublicationIntent(replay);
			}
			throw error;
		}
	},

	async read(workspaceId, postId) {
		const row = await requirePrisma().socialPost.findFirst({
			where: { id: postId, workspaceId },
			include: publicationIntentInclude,
		});
		return row && isAdmitted(row) ? toPublicationIntent(row) : null;
	},

	async cancel(input) {
		return requirePrisma().$transaction(async (tx) => {
			const cancelled = await tx.socialPost.updateMany({
				where: {
					id: input.postId,
					workspaceId: input.workspaceId,
					project: { workspaceId: input.workspaceId, ...accessibleProjectWhere() },
					status: { in: ["preparing_video", "scheduled"] },
				},
				data: { status: "cancelled" },
			});
			if (cancelled.count === 0) {
				const exists = await tx.socialPost.findFirst({
					where: { id: input.postId, workspaceId: input.workspaceId, project: { workspaceId: input.workspaceId, ...accessibleProjectWhere() } },
					select: { id: true },
				});
				throw new PublicationIntentStateError(
					exists ? "publication_already_started" : "social_post_not_found",
					exists
						? "The Social Post can no longer be cancelled"
						: "Social Post not found",
				);
			}
			await tx.socialPublicationAttempt.deleteMany({
				where: {
					socialPostId: input.postId,
					phase: "retry_scheduled",
					currentClaimId: null,
				},
			});
			const row = await tx.socialPost.findUniqueOrThrow({
				where: { id: input.postId },
				include: publicationIntentInclude,
			});
			await tx.projectAnalyticsEvent.create({
				data: {
					projectId: row.projectId,
					clipId: row.clipId,
					type: "social_cancelled",
					platform: row.platform,
					metadata: { socialPostId: row.id },
				},
			});
			return toPublicationIntent(row);
		});
	},

	async recordExportReady(input) {
		await requirePrisma().$transaction(async (tx) => {
			const states = await tx.frozenPublicationState.findMany({
				where: {
					clipExportVariantId: input.clipExportVariantId,
					socialPost: { status: "preparing_video" },
				},
				select: { id: true, socialPostId: true },
			});
			if (states.length === 0) return;
			await tx.frozenPublicationState.updateMany({
				where: { id: { in: states.map((state) => state.id) } },
				data: {
					storageKey: input.storageKey,
					sizeBytes: input.sizeBytes,
					durationSec: input.durationSec,
					mediaReadyAt: input.now,
				},
			});
			await tx.socialPost.updateMany({
				where: {
					id: { in: states.map((state) => state.socialPostId) },
					status: "preparing_video",
				},
				data: { status: "scheduled" },
			});
		});
	},
};

export function createProductionSocialPublicationScheduling() {
	return createSocialPublicationScheduling({
		store: prismaPublicationSchedulingStore,
		authorize: async ({ actorUserId, workspaceId, permission }) => {
			const actor = await workspaceService.requireActor(actorUserId, workspaceId, permission);
			return { ...actor, actorUserId };
		},
		authorizeReview: (input) => reviewApprovalGate.authorize(input),
		freezePorts: {
			providerEnabled: isSocialProviderPublishingEnabled,
			capabilityVersion: socialPublicationCapabilityVersion,
			async projectExists({ projectId, workspaceId }) {
				return Boolean(await requirePrisma().project.findFirst({
					where: { id: projectId, workspaceId, ...accessibleProjectWhere() }, select: { id: true },
				}));
			},
			readClip({ workspaceId, projectId, clipId }) {
				return requirePrisma().clip.findFirst({ where: { id: clipId, projectId, project: { workspaceId, ...accessibleProjectWhere() } }, select: { editorRevision: true } });
			},
			async readAccount(accountId) {
				const row = await requirePrisma().socialAccount.findUnique({
					where: { id: accountId },
					select: { workspaceId: true, platform: true, status: true, expiresAt: true, refreshTokenEncrypted: true },
				});
				return row ? { workspaceId: row.workspaceId, platform: row.platform, status: row.status,
					expiresAt: row.expiresAt, canRefresh: Boolean(row.refreshTokenEncrypted) } : null;
			},
			async readExport(exportId) {
				const row = await requirePrisma().clipExport.findUnique({
					where: { id: exportId },
					select: {
						id: true, workspaceId: true, projectId: true, clipId: true, editorRevision: true, resolution: true, fingerprint: true,
						variants: { select: { id: true, aspectRatio: true, resolution: true, status: true, storageKey: true, sizeBytes: true, durationSec: true } },
					},
				});
				return row ? { ...row, variants: row.variants.map((variant) => ({
					...variant, aspectRatio: clipAspectRatioFromDb[variant.aspectRatio],
					sizeBytes: variant.sizeBytes === null ? null : Number(variant.sizeBytes),
				})) } : null;
			},
			async createExport(input) {
				const result = await clipExportService.create({ workspaceId: input.workspaceId, actorUserId: input.actorUserId }, input.projectId, input.clipId, {
					expectedRevision: input.expectedEditorRevision, aspectRatios: [input.aspectRatio], resolution: input.resolution,
				}, `social:${input.workspaceId}:${input.clientIdempotencyKey}`);
				return result.export.id;
			},
			tiktokOptions: ({ workspaceId, accountId }) => readSocialPublishingOptionsForAccount(workspaceId, accountId),
			async requireCopyProvenance(input) { await assistedSocialCopyService.requireProvenance(input); },
			readThumbnailAsset({ actor, selection }) {
				return requirePrisma().visualAsset.findFirst({
					where: { id: selection.assetId, ...brandOwnerWhere(actor), fingerprint: selection.fingerprint, provenance: selection.source, kind: "image", deletedAt: null },
					select: { id: true, contentType: true, sizeBytes: true },
				});
			},
			async thumbnailFrameMatches(input) {
				return Boolean(await requirePrisma().thumbnailFrameOperation.findFirst({
					where: {
						resultAssetId: input.assetId, workspaceId: input.workspaceId, projectId: input.projectId, clipId: input.clipId,
						sourceTimeMs: input.sourceTimeMs, status: "completed", exportVariantId: input.exportVariantId,
						exportVariant: { aspectRatio: clipAspectRatioToDb[input.aspectRatio], export: { editorRevision: input.editorRevision } },
					}, select: { id: true },
				}));
			},
		},
		createId: randomUUID,
		now: () => new Date(),
	});
}

export const socialPublicationScheduling = createProductionSocialPublicationScheduling();
