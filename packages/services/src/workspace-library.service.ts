import { getPrismaClient } from "@narriflow/db/client";
import { Prisma } from "@prisma/client";
import type {
	IngestStatus as PrismaIngestStatus,
	TranscriptStatus as PrismaTranscriptStatus,
	ClipAspectRatio,
	ClipExportStatus,
	SocialPlatform,
	SocialPostStatus,
} from "@prisma/client";
import {
	deriveProjectListProgress,
	type ProjectListProgress,
	type SocialPostSnapshot,
} from "@narriflow/validators";
import { toProjectSnapshot, type ProjectSnapshot } from "./project-snapshot";
import {
	projectProgressStatusSql,
	projectProgressWorkflowOrderSql,
} from "./project-progress";

import type { ActorScope } from "./actor-scope";
import { accessibleProjectWhere } from "./project-access";
import {
	ExpectedDomainFailureError,
	type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";
import { workspaceService } from "./workspace.service";

const workspaceLibraryFailureCatalog = {
	workspace_folder_name_invalid: "invalid",
	workspace_folder_not_found: "missing",
	workspace_library_project_not_found: "missing",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type WorkspaceLibraryFailureCode =
	keyof typeof workspaceLibraryFailureCatalog;

export class WorkspaceLibraryError extends ExpectedDomainFailureError<WorkspaceLibraryFailureCode> {
	constructor(code: WorkspaceLibraryFailureCode, message: string) {
		super({ code, kind: workspaceLibraryFailureCatalog[code], message });
		this.name = "WorkspaceLibraryError";
	}
}

function requiredPrisma() {
	const prisma = getPrismaClient();
	if (!prisma)
		throw new Error(
			"DATABASE_URL is required for workspace library operations",
		);
	return prisma;
}

function normalizedFolderName(name: string) {
	return name
		.normalize("NFKC")
		.trim()
		.replace(/\s+/g, " ")
		.toLocaleLowerCase("en-US");
}

function validFolderName(name: string) {
	const trimmed = name.trim();
	if (trimmed.length < 1 || trimmed.length > 80) {
		throw new WorkspaceLibraryError(
			"workspace_folder_name_invalid",
			"Folder names must be between 1 and 80 characters",
		);
	}
	return trimmed;
}

// Carry the ordering values, so deleting the boundary record cannot strand a
// reader. Invalid URLs simply reopen the first page.
function libraryCursor(value: string | undefined) {
	if (!value || value.length > 256) return null;
	try {
		const [timestamp, id] = JSON.parse(Buffer.from(value, "base64url").toString());
		if (typeof timestamp !== "string" || typeof id !== "string" ||
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return null;
		const createdAt = new Date(timestamp);
		return Number.isFinite(createdAt.getTime()) ? { createdAt, id } : null;
	} catch { return null; }
}

function libraryContinuation(value: string | undefined) {
	const cursor = libraryCursor(value);
	return cursor ? [{ OR: [
		{ createdAt: { lt: cursor.createdAt } },
		{ createdAt: cursor.createdAt, id: { lt: cursor.id } },
	] }] : [];
}

function nextLibraryCursor(rows: { id: string; createdAt: Date }[]) {
	const boundary = rows[99];
	return rows.length > 100 && boundary
		? Buffer.from(JSON.stringify([boundary.createdAt.toISOString(), boundary.id])).toString("base64url")
		: null;
}

export interface ProjectListItem extends ProjectSnapshot {
	clipCount: number;
	avgViralityScore: number | null;
	/** Product-facing pipeline state. Source intake remains separate from
	 * Workflow Runs; this is their one shared interpretation for project lists. */
	progress: ProjectListProgress;
	transcript: {
		languageCode: string | null;
		speakerCount: number | null;
		durationSeconds: number | null;
		status: PrismaTranscriptStatus;
	} | null;
}

export type ProjectListStatusFilter =
	| "all"
	| "ready"
	| "processing"
	| "queued"
	| "failed";

export type ProjectListSourceFilter =
	| "all"
	| "youtube"
	| "link"
	| "upload"
	| "rss";
export type ProjectListSort = "newest" | "oldest" | "title" | "clips";

export interface ProjectListPage {
	items: ProjectListItem[];
	nextCursor: string | null;
	totalCount: number;
	statusCounts: Record<ProjectListStatusFilter, number>;
}

const DEFAULT_PROJECT_PAGE_SIZE = 50;
const MAX_PROJECT_PAGE_SIZE = 100;

function clampProjectPageSize(limit?: number) {
	if (!Number.isFinite(limit ?? DEFAULT_PROJECT_PAGE_SIZE)) {
		return DEFAULT_PROJECT_PAGE_SIZE;
	}

	return Math.max(
		1,
		Math.min(
			MAX_PROJECT_PAGE_SIZE,
			Math.floor(limit ?? DEFAULT_PROJECT_PAGE_SIZE),
		),
	);
}

function encodeProjectCursor(offset: number) {
	return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeProjectCursor(cursor: string | null | undefined) {
	if (!cursor) return 0;

	try {
		const parsed = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		) as { offset?: unknown };

		return typeof parsed.offset === "number" &&
			Number.isSafeInteger(parsed.offset) &&
			parsed.offset >= 0
			? parsed.offset
			: 0;
	} catch {
		return 0;
	}
}

function emptyProjectStatusCounts(): Record<ProjectListStatusFilter, number> {
	return { all: 0, ready: 0, processing: 0, queued: 0, failed: 0 };
}

export class WorkspaceLibraryService {
	async listProjects(
		scope: ActorScope,
		options: {
			limit?: number;
			cursor?: string | null;
			folderId?: string;
			query?: string;
			status?: ProjectListStatusFilter;
			source?: ProjectListSourceFilter;
			sort?: ProjectListSort;
		} = {},
	): Promise<ProjectListPage> {
		const limit = clampProjectPageSize(options.limit);
		const offset = decodeProjectCursor(options.cursor);
		const query = options.query?.trim().slice(0, 200) ?? "";
		const status = options.status ?? "all";
		const source = options.source ?? "all";
		const sort = options.sort ?? "newest";
		const prisma = requiredPrisma();

		await workspaceService.requireActor(
			scope.actorUserId,
			scope.workspaceId,
			"content.view",
		);
		const workspaceId = scope.workspaceId;
		const progressConditions = [
			Prisma.sql`p."workspaceId" = ${workspaceId}`,
			Prisma.sql`p."purgeStartedAt" IS NULL`,
			Prisma.sql`(p."expiresAt" IS NULL OR p."expiresAt" > NOW())`,
		];
		if (options.folderId)
			progressConditions.push(Prisma.sql`p."folderId" = ${options.folderId}`);
		if (source !== "all")
			progressConditions.push(
				Prisma.sql`p."sourceType" = CAST(${source} AS "SourceType")`,
			);
		if (query) {
			const pattern = `%${query
				.replaceAll("\\", "\\\\")
				.replaceAll("%", "\\%")
				.replaceAll("_", "\\_")}%`;
			progressConditions.push(
				Prisma.sql`(p.title ILIKE ${pattern} ESCAPE E'\\\\' OR p."sourceMediaUrl" ILIKE ${pattern} ESCAPE E'\\\\' OR p."sourceInput" ILIKE ${pattern} ESCAPE E'\\\\')`,
			);
		}
		const progressStatus = projectProgressStatusSql({
			ingestStatus: Prisma.sql`p."ingestStatus"`,
			workflowStatus: Prisma.sql`current_run.status`,
		});
		const workflowOrder = projectProgressWorkflowOrderSql();
		const progressCte = Prisma.sql`
			WITH listed AS (
				SELECT
					p.id,
					p."ingestStatus",
					current_run.id AS "workflowRunId",
					current_run."updatedAt" AS "workflowUpdatedAt",
					current_run.stage AS "workflowStage",
					current_run.status AS "workflowStatus",
					p."createdAt",
					p.title,
					${progressStatus} AS "progressStatus"
				FROM "Project" p
				LEFT JOIN LATERAL (
					SELECT id, "updatedAt", stage, status
					FROM "WorkflowRun"
					WHERE "projectId" = p.id
					ORDER BY ${workflowOrder}
					LIMIT 1
				) current_run ON TRUE
				WHERE ${Prisma.join(progressConditions, " AND ")}
			)
		`;
		const orderBy =
			sort === "oldest"
				? Prisma.sql`"createdAt" ASC, id ASC`
				: sort === "title"
					? Prisma.sql`title ASC, id ASC`
					: sort === "clips"
						? Prisma.sql`(SELECT COUNT(*) FROM "Clip" WHERE "projectId" = listed.id) DESC, "createdAt" DESC, id DESC`
						: Prisma.sql`"createdAt" DESC, id DESC`;
		type ProgressRow = {
			id: string;
			ingestStatus: PrismaIngestStatus;
			workflowRunId: string | null;
			workflowUpdatedAt: Date | null;
			workflowStage: string | null;
			workflowStatus: string | null;
			progressStatus: Exclude<ProjectListStatusFilter, "all">;
		};
		const statusFilter =
			status === "all"
				? Prisma.empty
				: Prisma.sql`WHERE "progressStatus" = ${status}`;
		const [pageWithLookahead, countRows] = await Promise.all([
			prisma.$queryRaw<ProgressRow[]>(Prisma.sql`
				${progressCte}
				SELECT id, "ingestStatus", "workflowRunId", "workflowUpdatedAt", "workflowStage", "workflowStatus", "progressStatus"
				FROM listed
				${statusFilter}
				ORDER BY ${orderBy}
				OFFSET ${offset} LIMIT ${limit + 1}
			`),
			prisma.$queryRaw<
				Array<{
					progressStatus: Exclude<ProjectListStatusFilter, "all">;
					count: bigint;
				}>
			>(Prisma.sql`
				${progressCte}
				SELECT "progressStatus", COUNT(*)::bigint AS count
				FROM listed
				GROUP BY "progressStatus"
			`),
		]);
		const statusCounts = emptyProjectStatusCounts();
		for (const row of countRows) {
			statusCounts.all += Number(row.count);
			statusCounts[row.progressStatus] += Number(row.count);
		}
		const totalCount =
			status === "all" ? statusCounts.all : statusCounts[status];
		const pageRows = pageWithLookahead.slice(0, limit);

		if (pageRows.length === 0) {
			return { items: [], nextCursor: null, totalCount, statusCounts };
		}

		const projectIds = pageRows.map((row) => row.id);

		const [projectRows, clipAggregates, transcripts] = await Promise.all([
			prisma.project.findMany({
				where: {
					id: { in: projectIds },
					workspaceId,
					...accessibleProjectWhere(),
				},
			}),
			prisma.clip.groupBy({
				by: ["projectId"],
				where: { projectId: { in: projectIds } },
				_count: { _all: true },
				_avg: { viralityScore: true },
			}),
			prisma.transcript.findMany({
				where: { projectId: { in: projectIds } },
				select: {
					projectId: true,
					languageCode: true,
					speakerCount: true,
					durationSeconds: true,
					status: true,
				},
			}),
		]);

		const clipMap = new Map(
			clipAggregates.map((entry) => [entry.projectId, entry] as const),
		);
		const transcriptMap = new Map(
			transcripts.map((entry) => [entry.projectId, entry] as const),
		);
		const projectMap = new Map(
			projectRows.map((row) => [row.id, row] as const),
		);

		const items = pageRows.flatMap((progressRow) => {
			const row = projectMap.get(progressRow.id);
			if (!row) return [];
			const clip = clipMap.get(row.id);
			const transcript = transcriptMap.get(row.id) ?? null;

			return [
				{
					...toProjectSnapshot(row),
					clipCount: clip?._count._all ?? 0,
					avgViralityScore: clip?._avg.viralityScore ?? null,
					progress: deriveProjectListProgress({
						ingestStatus: progressRow.ingestStatus,
						workflowRuns:
							progressRow.workflowRunId &&
							progressRow.workflowUpdatedAt &&
							progressRow.workflowStage &&
							progressRow.workflowStatus
								? [
										{
											id: progressRow.workflowRunId,
											stage: progressRow.workflowStage,
											status: progressRow.workflowStatus,
											updatedAt: progressRow.workflowUpdatedAt,
										},
									]
								: [],
					}),
					transcript: transcript
						? {
								languageCode: transcript.languageCode,
								speakerCount: transcript.speakerCount,
								durationSeconds: transcript.durationSeconds,
								status: transcript.status,
							}
						: null,
				},
			];
		});

		return {
			items,
			nextCursor:
				pageWithLookahead.length > limit && items.length > 0
					? encodeProjectCursor(offset + items.length)
					: null,
			totalCount,
			statusCounts,
		};
	}

	async search(scope: ActorScope, query: string) {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		const q = query.trim().slice(0, 120);
		if (q.length < 2) return [];
		const prisma = requiredPrisma();
		const [projects, folders, clips] = await Promise.all([
			prisma.project.findMany({
				where: {
					workspaceId: scope.workspaceId,
					...accessibleProjectWhere(),
					title: { contains: q, mode: "insensitive" },
				},
				select: { id: true, title: true, sourceType: true },
				orderBy: { updatedAt: "desc" },
				take: 8,
			}),
			prisma.workspaceFolder.findMany({
				where: { workspaceId: scope.workspaceId, name: { contains: q, mode: "insensitive" } },
				select: {
					id: true,
					name: true,
					_count: { select: { projects: true } },
				},
				orderBy: { updatedAt: "desc" },
				take: 6,
			}),
			prisma.clip.findMany({
				where: {
					project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
					OR: [
						{ title: { contains: q, mode: "insensitive" } },
						{ hookText: { contains: q, mode: "insensitive" } },
					],
				},
				select: {
					id: true,
					title: true,
					hookText: true,
					projectId: true,
					project: { select: { title: true } },
				},
				orderBy: { createdAt: "desc" },
				take: 8,
			}),
		]);

		return [
			...projects.map((project) => ({
				id: project.id,
				type: "project" as const,
				title: project.title,
				subtitle: project.sourceType,
				href: `/projects/${project.id}`,
			})),
			...folders.map((folder) => ({
				id: folder.id,
				type: "folder" as const,
				title: folder.name,
				subtitle: `${folder._count.projects} project${folder._count.projects === 1 ? "" : "s"}`,
				href: `/projects?folder=${folder.id}`,
			})),
			...clips.map((clip) => ({
				id: clip.id,
				type: "clip" as const,
				title: clip.title?.trim() || clip.hookText,
				subtitle: clip.project.title,
				href: `/projects/${clip.projectId}?clip=${clip.id}`,
			})),
		];
	}

	async listFolders(scope: ActorScope) {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		return requiredPrisma().workspaceFolder.findMany({
			where: { workspaceId: scope.workspaceId },
			select: {
				id: true,
				name: true,
				createdAt: true,
				_count: { select: { projects: true } },
			},
			orderBy: { name: "asc" },
		});
	}

	async createFolder(scope: ActorScope, name: string) {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
		const safeName = validFolderName(name);
		return requiredPrisma().workspaceFolder.create({
			data: {
				workspaceId: scope.workspaceId,
				name: safeName,
				normalizedName: normalizedFolderName(safeName),
				createdByUserId: scope.actorUserId,
			},
			select: { id: true, name: true, createdAt: true },
		});
	}

	async renameFolder(
		scope: ActorScope,
		folderId: string,
		name: string,
	) {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
		const safeName = validFolderName(name);
		const updated = await requiredPrisma().workspaceFolder.updateMany({
			where: { id: folderId, workspaceId: scope.workspaceId },
			data: { name: safeName, normalizedName: normalizedFolderName(safeName) },
		});
		if (updated.count === 0) {
			throw new WorkspaceLibraryError(
				"workspace_folder_not_found",
				"Folder not found",
			);
		}
	}

	async deleteFolder(scope: ActorScope, folderId: string) {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
		const prisma = requiredPrisma();
		await prisma.$transaction(async (tx) => {
			const folder = await tx.workspaceFolder.findFirst({
				where: { id: folderId, workspaceId: scope.workspaceId },
				select: { id: true },
			});
			if (!folder) {
				throw new WorkspaceLibraryError(
					"workspace_folder_not_found",
					"Folder not found",
				);
			}
			await tx.project.updateMany({
				where: { workspaceId: scope.workspaceId, folderId },
				data: { folderId: null },
			});
			await tx.workspaceFolder.delete({ where: { id: folderId } });
		});
	}

	async moveProject(
		scope: ActorScope,
		projectId: string,
		folderId: string | null,
	) {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
		const prisma = requiredPrisma();
		if (folderId) {
			const folder = await prisma.workspaceFolder.findFirst({
				where: { id: folderId, workspaceId: scope.workspaceId },
			});
			if (!folder) {
				throw new WorkspaceLibraryError(
					"workspace_folder_not_found",
					"Folder not found",
				);
			}
		}
		const updated = await prisma.project.updateMany({
			where: { id: projectId, workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
			data: { folderId, updatedByUserId: scope.actorUserId },
		});
		if (updated.count === 0) {
			throw new WorkspaceLibraryError(
				"workspace_library_project_not_found",
				"Project not found",
			);
		}
	}

	async listExports(
		scope: ActorScope,
		filters: {
			status?: ClipExportStatus | "processing";
			query?: string;
			projectId?: string;
			aspectRatio?: ClipAspectRatio;
			from?: Date;
			to?: Date;
			cursor?: string;
		} = {},
	) {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		const rows = await requiredPrisma().clipExport.findMany({
			where: {
				workspaceId: scope.workspaceId,
				AND: libraryContinuation(filters.cursor),
				...(filters.status === "processing"
					? {
							status: {
								in: [
									"queued",
									"rendering",
									"partial_ready",
								] as ClipExportStatus[],
							},
						}
					: filters.status
						? { status: filters.status }
						: {}),
				...(filters.projectId ? { projectId: filters.projectId } : {}),
				...(filters.aspectRatio
					? { variants: { some: { aspectRatio: filters.aspectRatio } } }
					: {}),
				...(filters.from || filters.to
					? {
							createdAt: {
								...(filters.from ? { gte: filters.from } : {}),
								...(filters.to ? { lte: filters.to } : {}),
							},
						}
					: {}),
				...(filters.query?.trim()
					? {
							OR: [
								{
									project: {
										title: {
											contains: filters.query.trim(),
											mode: "insensitive",
										},
									},
								},
								{
									clip: {
										title: {
											contains: filters.query.trim(),
											mode: "insensitive",
										},
									},
								},
							],
						}
					: {}),
			},
			select: {
				id: true,
				projectId: true,
				clipId: true,
				status: true,
				progress: true,
				resolution: true,
				watermark: true,
				createdAt: true,
				completedAt: true,
				errorCode: true,
				project: { select: { title: true } },
				clip: { select: { title: true, hookText: true } },
				variants: {
					select: {
						id: true,
						aspectRatio: true,
						status: true,
						storageKey: true,
						sizeBytes: true,
					},
					orderBy: { aspectRatio: "asc" },
				},
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 101,
		});
		return {
			items: rows.slice(0, 100).map((row) => ({
			...row,
			createdAt: row.createdAt.toISOString(),
			completedAt: row.completedAt?.toISOString() ?? null,
			variants: row.variants.map((variant) => ({
				...variant,
				sizeBytes:
					variant.sizeBytes === null ? null : Number(variant.sizeBytes),
			})),
			})),
			nextCursor: nextLibraryCursor(rows),
		};
	}

	async listExportProjects(scope: ActorScope) {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		return requiredPrisma().project.findMany({
			where: {
				workspaceId: scope.workspaceId,
				clipExports: { some: { workspaceId: scope.workspaceId } },
				...accessibleProjectWhere(),
			},
			select: { id: true, title: true },
			orderBy: { title: "asc" },
			take: 500,
		});
	}

	async listCalendarPosts(
		scope: ActorScope,
		filters: {
			from: Date;
			to: Date;
			status?: SocialPostStatus;
			platform?: SocialPlatform;
			accountId?: string;
			projectId?: string;
		},
	) {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		const rows = await requiredPrisma().socialPost.findMany({
			where: {
				workspaceId: scope.workspaceId,
				scheduledFor: { gte: filters.from, lte: filters.to },
				...(filters.status ? { status: filters.status } : {}),
				...(filters.platform ? { platform: filters.platform } : {}),
				...(filters.accountId ? { socialAccountId: filters.accountId } : {}),
				...(filters.projectId ? { projectId: filters.projectId } : {}),
			},
			select: {
				id: true,
				projectId: true,
				clipId: true,
				platform: true,
				status: true,
				caption: true,
				deliveryMode: true,
				publishedVideos: {
					select: { platformPostId: true, externalUrl: true },
				},
				scheduledFor: true,
				postedAt: true,
				externalUrl: true,
				errorCode: true,
				errorDisposition: true,
				nextAttemptAt: true,
				createdAt: true,
				project: { select: { title: true } },
				socialAccount: {
					select: { id: true, displayName: true, handle: true },
				},
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
			},
			orderBy: { scheduledFor: "asc" },
		});
		return rows.map((row) => ({
			...row,
			scheduledFor: row.scheduledFor?.toISOString() ?? null,
			postedAt: row.postedAt?.toISOString() ?? null,
			nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
			createdAt: row.createdAt.toISOString(),
			providerProcessingStatus:
				(row.publicationAttempts[0]?.receipt
					?.providerProcessingStatus as SocialPostSnapshot["providerProcessingStatus"]) ??
				null,
			providerProcessingFailureCode:
				row.publicationAttempts[0]?.receipt?.providerProcessingFailureCode ??
				null,
			providerVisibility:
				row.publicationAttempts[0]?.receipt?.providerVisibility ?? null,
		}));
	}

	async getCalendarFilters(scope: ActorScope) {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		const prisma = requiredPrisma();
		const [accounts, projects] = await Promise.all([
			prisma.socialAccount.findMany({
				where: { workspaceId: scope.workspaceId, status: { not: "revoked" } },
				select: { id: true, displayName: true, platform: true },
				orderBy: { displayName: "asc" },
			}),
			prisma.project.findMany({
				where: {
					workspaceId: scope.workspaceId,
					socialPosts: { some: { workspaceId: scope.workspaceId } },
					...accessibleProjectWhere(),
				},
				select: { id: true, title: true },
				orderBy: { title: "asc" },
			}),
		]);
		return { accounts, projects };
	}

	async getCalendarComposerOptions(
		scope: ActorScope,
		options: { query?: string; cursor?: string } = {},
	) {
		await workspaceService.requireActor(
			scope.actorUserId,
			scope.workspaceId,
			"publishing.manage",
		);
		const prisma = requiredPrisma();
		const [clips, accounts] = await Promise.all([
			prisma.clip.findMany({
				where: {
					project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
					AND: libraryContinuation(options.cursor),
					...(options.query?.trim()
						? {
							OR: [
								{ title: { contains: options.query.trim(), mode: "insensitive" } },
								{ hookText: { contains: options.query.trim(), mode: "insensitive" } },
								{ project: { title: { contains: options.query.trim(), mode: "insensitive" } } },
							],
						}
						: {}),
				},
				select: {
					id: true,
					createdAt: true,
					editorRevision: true,
					title: true,
					hookText: true,
					projectId: true,
					project: { select: { title: true } },
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 101,
			}),
			prisma.socialAccount.findMany({
				where: { workspaceId: scope.workspaceId, status: "active" },
				select: { id: true, platform: true, displayName: true, handle: true },
				orderBy: [{ platform: "asc" }, { displayName: "asc" }],
			}),
		]);
		return {
			clips: clips.slice(0, 100).map((clip) => ({
				id: clip.id,
				editorRevision: clip.editorRevision,
				projectId: clip.projectId,
				title: clip.title?.trim() || clip.hookText,
				projectTitle: clip.project.title,
				aspectRatios: [
					"ratio_9_16",
					"ratio_1_1",
					"ratio_16_9",
					"ratio_4_5",
				] as ClipAspectRatio[],
			})),
			accounts,
			nextCursor: nextLibraryCursor(clips),
		};
	}
}

export const workspaceLibraryService = new WorkspaceLibraryService();
