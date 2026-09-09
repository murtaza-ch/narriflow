import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	clipAspectRatioToDb,
	scheduleSocialPostSchema,
	socialPostMetricsSchema,
	type ScheduleSocialPostInput,
	type SocialPostMetricsInput,
	type SocialPostSnapshot,
	type ConfirmSocialPublicationInput,
	type RecheckSocialPublicationInput,
	type RepublishSocialPublicationInput,
} from "@narriflow/validators";
import { assistedSocialCopyService } from "./assisted-social-copy-runtime";
import { brandOwnerWhere } from "./brand-ownership";
import { createProductionSocialPublicationScheduling } from "./social-publication-scheduling";
import {
	allowedSocialPublicationActions,
	socialPublicationRecovery,
} from "./social-publication-recovery";
import {
	ThumbnailPreparationError,
	validateThumbnailSelection,
	validateProviderThumbnailAsset,
} from "./thumbnail-frame-preparation";
import { workspaceService } from "./workspace.service";
import {
	ExpectedDomainFailureError,
	type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

const socialPublicationScheduling =
	createProductionSocialPublicationScheduling();

const socialServiceFailureCatalog = {
	social_post_not_found: "missing",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type SocialServiceFailureCode = keyof typeof socialServiceFailureCatalog;

export class SocialServiceError extends ExpectedDomainFailureError<SocialServiceFailureCode> {
	constructor(code: SocialServiceFailureCode) {
		super({
			code,
			kind: socialServiceFailureCatalog[code],
			message: "Social post not found",
		});
		this.name = "SocialServiceError";
	}
}

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) {
		throw new Error("Database client unavailable");
	}
	return prisma;
}

function toSocialPostSnapshot(row: {
	id: string;
	projectId: string;
	clipId: string | null;
	socialAccountId?: string | null;
	socialAccount?: {
		displayName: string;
		handle: string | null;
		status?: string;
	} | null;
	workspace?: { status?: string } | null;
	deliveryMode?: "direct" | "tiktok_inbox";
	publishedVideos?: Array<{
		platformPostId: string;
		externalUrl: string | null;
	}>;
	platform: string;
	status: string;
	caption: string;
	aspectRatio: string | null;
	scheduledFor: Date | null;
	postedAt: Date | null;
	externalUrl: string | null;
	errorCode: string | null;
	errorDisposition?: string | null;
	nextAttemptAt?: Date | null;
	publicationAttempts?: Array<{
		receipt: {
			providerProcessingStatus: string | null;
			providerProcessingFailureCode: string | null;
			providerVisibility: string | null;
		} | null;
	}>;
	metrics?: Array<{
		views: number;
		likes: number;
		comments: number;
		shares: number;
		saves: number;
		watchTimeSeconds: number | null;
		capturedAt: Date;
	}>;
	createdAt: Date;
}): SocialPostSnapshot {
	const aspectRatio =
		row.aspectRatio === "ratio_9_16"
			? "9:16"
			: row.aspectRatio === "ratio_1_1"
				? "1:1"
				: row.aspectRatio === "ratio_16_9"
					? "16:9"
					: row.aspectRatio === "ratio_4_5"
						? "4:5"
						: null;

	return {
		deliveryMode: row.deliveryMode ?? "direct",
		publishedVideos: row.publishedVideos ?? [],
		id: row.id,
		projectId: row.projectId,
		clipId: row.clipId,
		accountId: row.socialAccountId ?? null,
		accountDisplayName: row.socialAccount?.displayName ?? null,
		accountHandle: row.socialAccount?.handle ?? null,
		platform: row.platform as SocialPostSnapshot["platform"],
		status: row.status as SocialPostSnapshot["status"],
		caption: row.caption,
		aspectRatio,
		scheduledFor: row.scheduledFor?.toISOString() ?? null,
		postedAt: row.postedAt?.toISOString() ?? null,
		externalUrl: row.externalUrl,
		errorCode: row.errorCode,
		errorDisposition:
			(row.errorDisposition as SocialPostSnapshot["errorDisposition"]) ?? null,
		nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
		providerProcessingStatus:
			(row.publicationAttempts?.[0]?.receipt
				?.providerProcessingStatus as SocialPostSnapshot["providerProcessingStatus"]) ??
			null,
		providerProcessingFailureCode:
			row.publicationAttempts?.[0]?.receipt?.providerProcessingFailureCode ??
			null,
		providerVisibility:
			row.publicationAttempts?.[0]?.receipt?.providerVisibility ?? null,
		allowedActions: allowedSocialPublicationActions(row),
		latestMetrics: row.metrics?.[0]
			? {
					views: row.metrics[0].views,
					likes: row.metrics[0].likes,
					comments: row.metrics[0].comments,
					shares: row.metrics[0].shares,
					saves: row.metrics[0].saves,
					watchTimeSeconds: row.metrics[0].watchTimeSeconds,
					capturedAt: row.metrics[0].capturedAt.toISOString(),
				}
			: null,
		createdAt: row.createdAt.toISOString(),
	};
}

export class SocialService {
	inspectPublication(
		workspaceId: string,
		socialPostId: string,
		projectId?: string,
	) {
		return socialPublicationRecovery.inspect({
			workspaceId,
			socialPostId,
			projectId,
		});
	}

	recheckPublication(
		workspaceId: string,
		actorUserId: string,
		socialPostId: string,
		input: RecheckSocialPublicationInput,
		projectId?: string,
	) {
		return socialPublicationRecovery.recheck({
			workspaceId,
			actorUserId,
			socialPostId,
			projectId,
			...input,
		});
	}

	confirmPublication(
		workspaceId: string,
		actorUserId: string,
		socialPostId: string,
		input: ConfirmSocialPublicationInput,
		projectId?: string,
	) {
		return socialPublicationRecovery.confirmPublished({
			workspaceId,
			actorUserId,
			socialPostId,
			projectId,
			...input,
		});
	}

	republishPublication(
		workspaceId: string,
		actorUserId: string,
		socialPostId: string,
		input: RepublishSocialPublicationInput,
		projectId?: string,
	) {
		return socialPublicationRecovery.publishAgain({
			workspaceId,
			actorUserId,
			socialPostId,
			projectId,
			...input,
		});
	}

	async listProjectPosts(
		userId: string,
		projectId: string,
	): Promise<SocialPostSnapshot[]> {
		const prisma = requirePrisma();
		const rows = await prisma.socialPost.findMany({
			where: { projectId, project: { userId } },
			orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
			include: {
				publishedVideos: true,
				socialAccount: {
					select: { displayName: true, handle: true, status: true },
				},
				workspace: { select: { status: true } },
				publicationAttempts: {
					orderBy: { attemptNumber: "desc" },
					take: 1,
					select: {
						receipt: {
							select: {
								providerProcessingStatus: true,
								providerProcessingFailureCode: true,
								providerVisibility: true,
							},
						},
					},
				},
				metrics: {
					orderBy: { capturedAt: "desc" },
					take: 1,
				},
			},
		});
		return rows.map(toSocialPostSnapshot);
	}

	async schedulePost(
		userId: string,
		projectId: string,
		input: ScheduleSocialPostInput,
		workspaceContext: { workspaceId: string; actorUserId: string },
	): Promise<SocialPostSnapshot> {
		const parsed = scheduleSocialPostSchema.parse(input);
		const prisma = requirePrisma();
		const scheduledFor = new Date(parsed.scheduledFor);
		const providerSettings = {
			...parsed.providerSettings,
			deliveryMode: parsed.deliveryMode,
			confirmedBy: workspaceContext.actorUserId,
		} as Prisma.JsonObject;
		if (parsed.assistedCopyVariantId) {
			await assistedSocialCopyService.requireProvenance({
				workspaceId: workspaceContext.workspaceId,
				projectId,
				clipId: parsed.clipId,
				platform: parsed.platform,
				variantId: parsed.assistedCopyVariantId,
			});
			providerSettings.assistedCopyVariantId = parsed.assistedCopyVariantId;
		}
		if (parsed.thumbnail) {
			const actor = await workspaceService.requireActor(
				workspaceContext.actorUserId,
				workspaceContext.workspaceId,
				"publishing.manage",
			);
			const normalized = validateThumbnailSelection({
				platform: parsed.platform,
				selection: parsed.thumbnail,
			});
			const asset = await prisma.visualAsset.findFirst({
				where: {
					id: parsed.thumbnail.assetId,
					...brandOwnerWhere({
						actorUserId: workspaceContext.actorUserId,
						workspaceId: actor.workspaceId,
						workspaceOwnerUserId: actor.workspaceOwnerUserId,
						role: actor.role,
						status: actor.status,
						pricingTier: actor.pricingTier,
						isPersonalWorkspace: actor.isPersonalWorkspace,
					}),
					fingerprint: parsed.thumbnail.fingerprint,
					provenance: parsed.thumbnail.source,
					kind: "image",
					deletedAt: null,
				},
				select: { id: true, contentType: true, sizeBytes: true },
			});
			if (!asset) {
				throw new ThumbnailPreparationError(
					"thumbnail_asset_unavailable",
					"The selected thumbnail is missing or was deleted",
				);
			}
			validateProviderThumbnailAsset({
				platform: parsed.platform,
				contentType: asset.contentType,
				sizeBytes: asset.sizeBytes,
			});
			if (parsed.thumbnail.source === "extracted_frame") {
				const operation = await prisma.thumbnailFrameOperation.findFirst({
					where: {
						resultAssetId: asset.id,
						workspaceId: workspaceContext.workspaceId,
						projectId,
						clipId: parsed.clipId,
						sourceTimeMs: parsed.thumbnail.sourceTimeMs!,
						status: "completed",
						exportVariantId: parsed.clipExportVariantId,
						exportVariant: {
							aspectRatio: clipAspectRatioToDb[parsed.aspectRatio],
							export: { editorRevision: parsed.expectedEditorRevision },
						},
					},
					select: { id: true },
				});
				if (!operation) {
					throw new ThumbnailPreparationError(
						"thumbnail_export_mismatch",
						"The frame does not belong to the selected export revision",
					);
				}
			}
			Object.assign(providerSettings, normalized);
		}
		const intent = await socialPublicationScheduling.schedule({
			immediate: parsed.immediate,
			actorUserId: workspaceContext.actorUserId,
			ownerUserId: userId,
			workspaceId: workspaceContext.workspaceId,
			projectId,
			clientIdempotencyKey: parsed.clientIdempotencyKey,
			clipId: parsed.clipId,
			expectedEditorRevision: parsed.expectedEditorRevision,
			clipExportId: parsed.clipExportId,
			clipExportVariantId: parsed.clipExportVariantId,
			accountId: parsed.accountId,
			platform: parsed.platform,
			caption: parsed.caption,
			aspectRatio: parsed.aspectRatio,
			resolution: parsed.resolution,
			scheduledFor,
			providerSettings,
			reviewOverrideReason: parsed.reviewOverrideReason,
		});

		const row = await prisma.socialPost.findUnique({
			where: { id: intent.id },
			include: {
				publishedVideos: true,
				socialAccount: {
					select: { displayName: true, handle: true, status: true },
				},
				workspace: { select: { status: true } },
				publicationAttempts: {
					orderBy: { attemptNumber: "desc" },
					take: 1,
					select: {
						receipt: {
							select: {
								providerProcessingStatus: true,
								providerProcessingFailureCode: true,
								providerVisibility: true,
							},
						},
					},
				},
				metrics: {
					orderBy: { capturedAt: "desc" },
					take: 1,
				},
			},
		});
		if (!row) throw new Error("social post not found after scheduling");
		return toSocialPostSnapshot(row);
	}

	async cancelPost(
		projectId: string,
		postId: string,
		workspaceContext: { workspaceId: string; actorUserId: string },
	): Promise<SocialPostSnapshot> {
		const prisma = requirePrisma();
		const existing = await prisma.socialPost.findFirst({
			where: {
				id: postId,
				projectId,
				workspaceId: workspaceContext.workspaceId,
			},
			select: { id: true },
		});
		if (!existing) {
			throw new SocialServiceError("social_post_not_found");
		}
		await socialPublicationScheduling.cancel({
			actorUserId: workspaceContext.actorUserId,
			workspaceId: workspaceContext.workspaceId,
			postId,
		});

		const row = await prisma.socialPost.findUnique({
			where: { id: postId },
			include: {
				publishedVideos: true,
				socialAccount: {
					select: { displayName: true, handle: true, status: true },
				},
				workspace: { select: { status: true } },
				metrics: {
					orderBy: { capturedAt: "desc" },
					take: 1,
				},
			},
		});
		if (!row) {
			throw new SocialServiceError("social_post_not_found");
		}

		return toSocialPostSnapshot(row);
	}

	async recordPostMetrics(
		userId: string,
		projectId: string,
		postId: string,
		input: SocialPostMetricsInput,
	) {
		const prisma = requirePrisma();
		const post = await prisma.socialPost.findFirst({
			where: { id: postId, projectId, project: { userId } },
			select: { id: true },
		});
		if (!post) {
			throw new SocialServiceError("social_post_not_found");
		}

		return this.recordMetricsForPostId(post.id, input);
	}

	async recordMetricsForPostId(postId: string, input: SocialPostMetricsInput) {
		const parsed = socialPostMetricsSchema.parse(input);
		const prisma = requirePrisma();
		const post = await prisma.socialPost.findUnique({
			where: { id: postId },
			select: { id: true, projectId: true, platform: true },
		});
		if (!post) {
			throw new SocialServiceError("social_post_not_found");
		}

		await prisma.socialPostMetric.create({
			data: {
				projectId: post.projectId,
				postId: post.id,
				platform: post.platform,
				views: parsed.views,
				likes: parsed.likes,
				comments: parsed.comments,
				shares: parsed.shares,
				saves: parsed.saves,
				watchTimeSeconds: parsed.watchTimeSeconds ?? null,
				capturedAt: parsed.capturedAt
					? new Date(parsed.capturedAt)
					: new Date(),
				metadata: parsed.metadata
					? (parsed.metadata as Prisma.InputJsonValue)
					: Prisma.JsonNull,
			},
		});

		const updated = await prisma.socialPost.findUnique({
			where: { id: post.id },
			include: {
				publishedVideos: true,
				socialAccount: {
					select: { displayName: true, handle: true, status: true },
				},
				workspace: { select: { status: true } },
				publicationAttempts: {
					orderBy: { attemptNumber: "desc" },
					take: 1,
					select: {
						receipt: {
							select: {
								providerProcessingStatus: true,
								providerProcessingFailureCode: true,
								providerVisibility: true,
							},
						},
					},
				},
				metrics: {
					orderBy: { capturedAt: "desc" },
					take: 1,
				},
			},
		});

		if (!updated) {
			throw new SocialServiceError("social_post_not_found");
		}

		return toSocialPostSnapshot(updated);
	}
}

export const socialService = new SocialService();
