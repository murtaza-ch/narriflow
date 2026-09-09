import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	bulkSocialScheduleSchema,
	publishingPreviewSchema,
	type BulkSocialScheduleRequest,
} from "@narriflow/validators";
import { composeAssistedCopyCaption } from "./assisted-social-copy";
import {
	BulkSocialSchedulingError,
	bulkScheduleDeterministicUuid,
	createBulkSocialScheduling,
	publishingSlots,
	type BulkScheduleItem,
	type BulkScheduleOperation,
	type BulkScheduleStore,
} from "./bulk-social-scheduling";
import { hasFeature } from "./plan-features";
import { accessibleProjectWhere } from "./project-access";
import { socialService } from "./social.service";
import { workspaceService } from "./workspace.service";

const operationInclude = {
	items: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.CampaignOperationInclude;

type OperationRow = Prisma.CampaignOperationGetPayload<{
	include: typeof operationInclude;
}>;

type StoredItemResult = {
	requestKey?: string;
	clipId?: string;
	accountId?: string;
	platform?: string;
	scheduledFor?: string;
	retryable?: boolean;
	socialPostId?: string | null;
};

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function storedResult(value: Prisma.JsonValue | null): StoredItemResult {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as StoredItemResult)
		: {};
}

function toItem(row: OperationRow["items"][number]): BulkScheduleItem {
	const result = storedResult(row.result);
	const clipId = row.clipId ?? result.clipId;
	if (
		!clipId ||
		row.expectedEditorRevision === null ||
		!result.requestKey ||
		!result.accountId ||
		!result.platform
	) {
		throw new BulkSocialSchedulingError("campaign_schedule_item_incomplete");
	}
	return {
		id: row.id,
		requestKey: result.requestKey,
		clipId,
		expectedEditorRevision: row.expectedEditorRevision,
		accountId: result.accountId,
		platform: result.platform as BulkScheduleItem["platform"],
		scheduledFor: result.scheduledFor ? new Date(result.scheduledFor) : null,
		status: row.status as BulkScheduleItem["status"],
		errorCode: row.errorCode,
		retryable: result.retryable === true,
		socialPostId: result.socialPostId ?? null,
	};
}

function toOperation(row: OperationRow): BulkScheduleOperation {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		idempotencyKey: row.idempotencyKey,
		requestFingerprint: row.requestFingerprint,
		status: row.status as BulkScheduleOperation["status"],
		items: row.items.map(toItem),
		createdAt: row.createdAt,
		completedAt: row.completedAt,
	};
}

async function readOperation(
	workspaceId: string,
	projectId: string,
	idempotencyKey: string,
) {
	return requirePrisma().campaignOperation.findUnique({
		where: {
			workspaceId_projectId_action_idempotencyKey: {
				workspaceId,
				projectId,
				action: "schedule_selected",
				idempotencyKey,
			},
		},
		include: operationInclude,
	});
}

export const prismaBulkScheduleStore: BulkScheduleStore = {
	async open(input) {
		const existing = await readOperation(
			input.workspaceId,
			input.projectId,
			input.idempotencyKey,
		);
		if (existing) return { operation: toOperation(existing), replayed: true };
		const candidate = input.create();
		try {
			const created = await requirePrisma().campaignOperation.create({
				data: {
					id: candidate.id,
					workspaceId: candidate.workspaceId,
					projectId: candidate.projectId,
					actorUserId: input.actorUserId,
					action: "schedule_selected",
					idempotencyKey: candidate.idempotencyKey,
					requestFingerprint: candidate.requestFingerprint,
					validatedOptions: input.validatedOptions as Prisma.InputJsonValue,
					pricingTier: input.pricingTier,
					status: "running",
					requestedCount: candidate.items.length,
					items: {
						create: candidate.items.map((item) => ({
							id: item.id,
							requestedClipId: bulkScheduleDeterministicUuid(item.requestKey),
							clipId: item.clipId,
							expectedEditorRevision: item.expectedEditorRevision,
							status: "pending",
							result: {
								requestKey: item.requestKey,
								clipId: item.clipId,
								accountId: item.accountId,
								platform: item.platform,
								scheduledFor: item.scheduledFor?.toISOString() ?? null,
								retryable: false,
								socialPostId: null,
							},
						})),
					},
				},
				include: operationInclude,
			});
			await requirePrisma().projectAnalyticsEvent.create({
				data: {
					projectId: candidate.projectId,
					type: "campaign_operation_started",
					metadata: {
						operationId: candidate.id,
						action: "schedule_selected",
						requestedCount: candidate.items.length,
					},
				},
			});
			return { operation: toOperation(created), replayed: false };
		} catch (error) {
			if (
				!(error instanceof Prisma.PrismaClientKnownRequestError) ||
				error.code !== "P2002"
			) {
				throw error;
			}
			const raced = await readOperation(
				input.workspaceId,
				input.projectId,
				input.idempotencyKey,
			);
			if (!raced) throw error;
			return { operation: toOperation(raced), replayed: true };
		}
	},

	async claimItem(operationId, requestKey) {
		const requestedClipId = bulkScheduleDeterministicUuid(requestKey);
		const now = new Date();
		const claimToken = bulkScheduleDeterministicUuid(
			`${operationId}:${requestKey}:${now.toISOString()}`,
		);
		const claimed = await requirePrisma().campaignOperationItem.updateMany({
			where: {
				operationId,
				requestedClipId,
				OR: [
					{ status: "pending" },
					{ status: "processing", leaseExpiresAt: { lte: now } },
				],
			},
			data: {
				status: "processing",
				claimToken,
				leaseExpiresAt: new Date(now.getTime() + 10 * 60_000),
			},
		});
		if (claimed.count !== 1) return null;
		const operation = await requirePrisma().campaignOperation.findUniqueOrThrow(
			{
				where: { id: operationId },
				include: operationInclude,
			},
		);
		const row = operation.items.find(
			(item) => item.requestedClipId === requestedClipId,
		);
		if (!row || row.claimToken !== claimToken) return null;
		return { item: toItem(row), claimToken };
	},

	async settleItem(operationId, requestKey, claimToken, patch) {
		const requestedClipId = bulkScheduleDeterministicUuid(requestKey);
		await requirePrisma().$transaction(async (tx) => {
			const current = await tx.campaignOperationItem.findFirst({
				where: {
					operationId,
					requestedClipId,
					status: "processing",
					claimToken,
				},
			});
			if (!current)
				throw new BulkSocialSchedulingError("campaign_schedule_claim_lost");
			const result = storedResult(current.result);
			const frozen = patch.socialPostId
				? await tx.socialPost.findUnique({
						where: { id: patch.socialPostId },
						select: {
							reviewApprovalOverrideId: true,
							frozenState: { select: { clipExportId: true } },
						},
					})
				: null;
			const settled = await tx.campaignOperationItem.updateMany({
				where: { id: current.id, status: "processing", claimToken },
				data: {
					status: patch.status,
					errorCode: patch.errorCode,
					exportId: frozen?.frozenState?.clipExportId ?? current.exportId,
					reviewApprovalOverrideId:
						frozen?.reviewApprovalOverrideId ??
						current.reviewApprovalOverrideId,
					result: {
						...result,
						retryable: patch.retryable,
						socialPostId: patch.socialPostId,
					},
					settledAt: new Date(),
					claimToken: null,
					leaseExpiresAt: null,
				},
			});
			if (settled.count !== 1) {
				throw new BulkSocialSchedulingError("campaign_schedule_claim_lost");
			}
		});
	},

	async settleOperation(operationId, now) {
		return requirePrisma().$transaction(async (tx) => {
			const grouped = await tx.campaignOperationItem.groupBy({
				by: ["status"],
				where: { operationId },
				_count: { _all: true },
			});
			const count = (status: string) =>
				grouped.find((entry) => entry.status === status)?._count._all ?? 0;
			if (count("pending") + count("processing") > 0) {
				const running = await tx.campaignOperation.findUniqueOrThrow({
					where: { id: operationId },
					include: operationInclude,
				});
				return toOperation(running);
			}
			const succeeded = count("succeeded");
			const ineligible = count("ineligible");
			const failed = count("failed");
			const operation = await tx.campaignOperation.update({
				where: { id: operationId },
				data: {
					status:
						succeeded === 0
							? "failed"
							: ineligible + failed > 0
								? "partial"
								: "completed",
					succeededCount: succeeded,
					ineligibleCount: ineligible,
					failedCount: failed,
					completedAt: now,
				},
				include: operationInclude,
			});
			await tx.projectAnalyticsEvent.createMany({
				data: [
					{
						projectId: operation.projectId,
						type: "campaign_schedule_completed",
						metadata: {
							operationId,
							requestedCount: operation.requestedCount,
							succeededCount: succeeded,
							ineligibleCount: ineligible,
							failedCount: failed,
							outcome: operation.status,
						},
					},
					{
						projectId: operation.projectId,
						type: "campaign_operation_completed",
						metadata: {
							operationId,
							action: "schedule_selected",
							outcome: operation.status,
						},
					},
				],
			});
			return toOperation(operation);
		});
	},
};

function productionModule() {
	return createBulkSocialScheduling({
		store: prismaBulkScheduleStore,
		authorize: async ({
			actorUserId,
			workspaceId,
			projectId,
			clipIds,
			bulk,
			permission,
		}) => {
			const actor = await workspaceService.requireActor(
				actorUserId,
				workspaceId,
				permission,
			);
			if (bulk && !hasFeature(actor.pricingTier, "campaign.operations")) {
				throw new BulkSocialSchedulingError(
					"campaign_schedule_entitlement_required",
					"Bulk scheduling requires a Pro or Business plan",
				);
			}
			const workspace = await requirePrisma().workspace.findUnique({
				where: { id: workspaceId },
				select: { timezone: true },
			});
			if (!workspace)
				throw new BulkSocialSchedulingError("workspace_not_found");
			const project = await requirePrisma().project.findFirst({
				where: { id: projectId, workspaceId, ...accessibleProjectWhere() },
				select: {
					id: true,
					_count: { select: { clips: { where: { id: { in: clipIds } } } } },
				},
			});
			if (!project || project._count.clips !== new Set(clipIds).size) {
				throw new BulkSocialSchedulingError(
					"campaign_schedule_clip_not_found",
					"Every selected clip must belong to the active project",
				);
			}
			return { pricingTier: actor.pricingTier, timeZone: workspace.timezone };
		},
		async schedule(input) {
			const workspace = await requirePrisma().workspace.findUnique({
				where: { id: input.workspaceId },
				select: { ownerUserId: true },
			});
			if (!workspace)
				throw new BulkSocialSchedulingError("workspace_not_found");
			const post = await socialService.schedulePost(
				workspace.ownerUserId,
				input.projectId,
				{
					clientIdempotencyKey: input.clientIdempotencyKey,
					deliveryMode: input.deliveryMode,
					immediate: input.immediate,
					clipId: input.clipId,
					expectedEditorRevision: input.expectedEditorRevision,
					clipExportId: input.clipExportId,
					clipExportVariantId: input.clipExportVariantId,
					accountId: input.accountId,
					platform: input.platform,
					caption: composeAssistedCopyCaption(input),
					aspectRatio: input.aspectRatio,
					resolution: input.resolution,
					scheduledFor: input.scheduledFor.toISOString(),
					providerSettings: {
						...input.providerSettings,
						...(input.title &&
						input.deliveryMode === "direct" &&
						input.platform !== "tiktok"
							? { title: input.title }
							: {}),
					},
					assistedCopyVariantId: input.assistedCopyVariantId,
					thumbnail: input.thumbnail,
					reviewOverrideReason: input.reviewOverrideReason,
				},
				{ workspaceId: input.workspaceId, actorUserId: input.actorUserId },
			);
			return {
				socialPostId: post.id,
				status:
					post.status === "preparing_video"
						? ("preparing_video" as const)
						: ("scheduled" as const),
			};
		},
		createId: randomUUID,
		now: () => new Date(),
	});
}

export class BulkSocialSchedulingService {
	async preview(actorUserId: string, workspaceId: string, value: unknown) {
		await workspaceService.requireActor(
			actorUserId,
			workspaceId,
			"publishing.manage",
		);
		const input = publishingPreviewSchema.parse(value);
		const workspace = await requirePrisma().workspace.findUnique({
			where: { id: workspaceId },
			select: { timezone: true },
		});
		if (workspace?.timezone !== input.timeZone)
			throw new BulkSocialSchedulingError("schedule_timezone_mismatch");
		return {
			slots: publishingSlots(input).map((date, index) => ({
				clipId: input.clipIds[index],
				scheduledFor: date.toISOString(),
			})),
		};
	}

	schedule(input: {
		actorUserId: string;
		workspaceId: string;
		projectId: string;
		value: unknown;
	}) {
		const parsed: BulkSocialScheduleRequest = bulkSocialScheduleSchema.parse(
			input.value,
		);
		return productionModule().schedule({
			actorUserId: input.actorUserId,
			workspaceId: input.workspaceId,
			projectId: input.projectId,
			...parsed,
		});
	}
}

export const bulkSocialSchedulingService = new BulkSocialSchedulingService();
