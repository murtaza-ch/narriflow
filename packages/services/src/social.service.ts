import type { ActorScope } from "./actor-scope";
import { workspaceService } from "./workspace.service";
import { accessibleProjectWhere } from "./project-access";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	socialPostMetricsSchema,
	type SocialPostMetricsInput,
	type SocialPostSnapshot,
	type ConfirmSocialPublicationInput,
	type RecheckSocialPublicationInput,
	type RepublishSocialPublicationInput,
} from "@narriflow/validators";
import { socialPublicationScheduling } from "./social-publication-scheduling-runtime";
import {
	allowedSocialPublicationActions,
	socialPublicationRecovery,
} from "./social-publication-recovery";
type SocialPostCursor = { createdAt: string; id: string };

function decodeSocialPostCursor(value: string | undefined): SocialPostCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		if (
			typeof parsed?.id !== "string" ||
			typeof parsed?.createdAt !== "string" ||
			!/^\w{8}-(?:\w{4}-){3}\w{12}$/.test(parsed.id) ||
			Number.isNaN(Date.parse(parsed.createdAt))
		)
			return null;
		return parsed;
	} catch {
		return null;
	}
}

function encodeSocialPostCursor(row: { createdAt: Date; id: string }) {
	return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}
import {
	ExpectedDomainFailureError,
	type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

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

const socialPostSnapshotInclude = {
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
			} satisfies Prisma.SocialPostInclude;

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
	async inspectPublication(
		scope: ActorScope,
		socialPostId: string,
		projectId?: string,
	) {
		return socialPublicationRecovery.inspect({
			...scope,
			socialPostId,
			projectId,
		});
	}

	recheckPublication(
		scope: ActorScope,
		socialPostId: string,
		input: RecheckSocialPublicationInput,
		projectId?: string,
	) {
		return socialPublicationRecovery.recheck({
			...scope,
			socialPostId,
			projectId,
			...input,
		});
	}

	confirmPublication(
		scope: ActorScope,
		socialPostId: string,
		input: ConfirmSocialPublicationInput,
		projectId?: string,
	) {
		return socialPublicationRecovery.confirmPublished({
			...scope,
			socialPostId,
			projectId,
			...input,
		});
	}

	republishPublication(
		scope: ActorScope,
		socialPostId: string,
		input: RepublishSocialPublicationInput,
		projectId?: string,
	) {
		return socialPublicationRecovery.publishAgain({
			...scope,
			socialPostId,
			projectId,
			...input,
		});
	}

	async listProjectPosts(
		scope: ActorScope,
		projectId: string,
		options: { activeOnly?: boolean; trackedIds?: string[]; cursor?: string } = {},
	): Promise<{ items: SocialPostSnapshot[]; nextCursor: string | null }> {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		const prisma = requirePrisma();
		const cursor = decodeSocialPostCursor(options.cursor);
		const rows = await prisma.socialPost.findMany({
			where: {
				projectId,
				workspaceId: scope.workspaceId,
				project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
				...(cursor
					? {
						OR: [
							{ createdAt: { lt: new Date(cursor.createdAt) } },
							{ createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
						],
					}
					: {}),
				...(options.activeOnly
					? {
						...(options.trackedIds?.length
							? { id: { in: options.trackedIds.slice(0, 100) } }
							: { status: { in: ["preparing_video", "scheduled", "publishing", "processing", "reconciling"] } }),
					}
					: {}),
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 101,
			include: socialPostSnapshotInclude,
		});
		return { items: rows.slice(0, 100).map(toSocialPostSnapshot), nextCursor: rows.length > 100 ? encodeSocialPostCursor(rows[99]!) : null };
	}

	async cancelPost(
		scope: ActorScope,
		projectId: string,
		postId: string,
	): Promise<SocialPostSnapshot> {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "publishing.manage");
		const prisma = requirePrisma();
		const existing = await prisma.socialPost.findFirst({
			where: {
				id: postId,
				projectId,
				workspaceId: scope.workspaceId,
				project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
			},
			select: { id: true },
		});
		if (!existing) {
			throw new SocialServiceError("social_post_not_found");
		}
		await socialPublicationScheduling.cancel({
			actorUserId: scope.actorUserId,
			workspaceId: scope.workspaceId,
			postId,
		});

		const row = await prisma.socialPost.findUnique({
			where: { id: postId },
			include: socialPostSnapshotInclude,
		});
		if (!row) {
			throw new SocialServiceError("social_post_not_found");
		}

		return toSocialPostSnapshot(row);
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
			include: socialPostSnapshotInclude,
		});

		if (!updated) {
			throw new SocialServiceError("social_post_not_found");
		}

		return toSocialPostSnapshot(updated);
	}
}

export const socialService = new SocialService();
