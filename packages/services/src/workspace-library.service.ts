import { getPrismaClient } from "@narriflow/db/client";
import type {
	ClipAspectRatio,
	ClipExportStatus,
	SocialPlatform,
	SocialPostStatus,
} from "@prisma/client";
import type { SocialPostSnapshot } from "@narriflow/validators";

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

export class WorkspaceLibraryService {
	async search(userId: string, workspaceId: string, query: string) {
		await workspaceService.requireActor(userId, workspaceId, "content.view");
		const q = query.trim().slice(0, 120);
		if (q.length < 2) return [];
		const prisma = requiredPrisma();
		const [projects, folders, clips] = await Promise.all([
			prisma.project.findMany({
				where: {
					workspaceId,
					...accessibleProjectWhere(),
					title: { contains: q, mode: "insensitive" },
				},
				select: { id: true, title: true, sourceType: true },
				orderBy: { updatedAt: "desc" },
				take: 8,
			}),
			prisma.workspaceFolder.findMany({
				where: { workspaceId, name: { contains: q, mode: "insensitive" } },
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
					project: { workspaceId, ...accessibleProjectWhere() },
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

	async listFolders(userId: string, workspaceId: string) {
		await workspaceService.requireActor(userId, workspaceId, "content.view");
		return requiredPrisma().workspaceFolder.findMany({
			where: { workspaceId },
			select: {
				id: true,
				name: true,
				createdAt: true,
				_count: { select: { projects: true } },
			},
			orderBy: { name: "asc" },
		});
	}

	async createFolder(userId: string, workspaceId: string, name: string) {
		await workspaceService.requireActor(userId, workspaceId, "content.edit");
		const safeName = validFolderName(name);
		return requiredPrisma().workspaceFolder.create({
			data: {
				workspaceId,
				name: safeName,
				normalizedName: normalizedFolderName(safeName),
				createdByUserId: userId,
			},
			select: { id: true, name: true, createdAt: true },
		});
	}

	async renameFolder(
		userId: string,
		workspaceId: string,
		folderId: string,
		name: string,
	) {
		await workspaceService.requireActor(userId, workspaceId, "content.edit");
		const safeName = validFolderName(name);
		const updated = await requiredPrisma().workspaceFolder.updateMany({
			where: { id: folderId, workspaceId },
			data: { name: safeName, normalizedName: normalizedFolderName(safeName) },
		});
		if (updated.count === 0) {
			throw new WorkspaceLibraryError(
				"workspace_folder_not_found",
				"Folder not found",
			);
		}
	}

	async deleteFolder(userId: string, workspaceId: string, folderId: string) {
		await workspaceService.requireActor(userId, workspaceId, "content.edit");
		const prisma = requiredPrisma();
		await prisma.$transaction(async (tx) => {
			const folder = await tx.workspaceFolder.findFirst({
				where: { id: folderId, workspaceId },
				select: { id: true },
			});
			if (!folder) {
				throw new WorkspaceLibraryError(
					"workspace_folder_not_found",
					"Folder not found",
				);
			}
			await tx.project.updateMany({
				where: { workspaceId, folderId },
				data: { folderId: null },
			});
			await tx.workspaceFolder.delete({ where: { id: folderId } });
		});
	}

	async moveProject(
		userId: string,
		workspaceId: string,
		projectId: string,
		folderId: string | null,
	) {
		await workspaceService.requireActor(userId, workspaceId, "content.edit");
		const prisma = requiredPrisma();
		if (folderId) {
			const folder = await prisma.workspaceFolder.findFirst({
				where: { id: folderId, workspaceId },
			});
			if (!folder) {
				throw new WorkspaceLibraryError(
					"workspace_folder_not_found",
					"Folder not found",
				);
			}
		}
		const updated = await prisma.project.updateMany({
			where: { id: projectId, workspaceId, ...accessibleProjectWhere() },
			data: { folderId, updatedByUserId: userId },
		});
		if (updated.count === 0) {
			throw new WorkspaceLibraryError(
				"workspace_library_project_not_found",
				"Project not found",
			);
		}
	}

	async listExports(
		userId: string,
		workspaceId: string,
		filters: {
			status?: ClipExportStatus | "processing";
			query?: string;
			projectId?: string;
			aspectRatio?: ClipAspectRatio;
			from?: Date;
			to?: Date;
		} = {},
	) {
		await workspaceService.requireActor(userId, workspaceId, "content.view");
		const rows = await requiredPrisma().clipExport.findMany({
			where: {
				workspaceId,
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
			orderBy: { createdAt: "desc" },
			take: 200,
		});
		return rows.map((row) => ({
			...row,
			createdAt: row.createdAt.toISOString(),
			completedAt: row.completedAt?.toISOString() ?? null,
			variants: row.variants.map((variant) => ({
				...variant,
				sizeBytes:
					variant.sizeBytes === null ? null : Number(variant.sizeBytes),
			})),
		}));
	}

	async listExportProjects(userId: string, workspaceId: string) {
		await workspaceService.requireActor(userId, workspaceId, "content.view");
		return requiredPrisma().project.findMany({
			where: {
				workspaceId,
				clipExports: { some: { workspaceId } },
				...accessibleProjectWhere(),
			},
			select: { id: true, title: true },
			orderBy: { title: "asc" },
			take: 500,
		});
	}

	async listCalendarPosts(
		userId: string,
		workspaceId: string,
		filters: {
			from: Date;
			to: Date;
			status?: SocialPostStatus;
			platform?: SocialPlatform;
			accountId?: string;
			projectId?: string;
		},
	) {
		await workspaceService.requireActor(userId, workspaceId, "content.view");
		const rows = await requiredPrisma().socialPost.findMany({
			where: {
				workspaceId,
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

	async getCalendarFilters(userId: string, workspaceId: string) {
		await workspaceService.requireActor(userId, workspaceId, "content.view");
		const prisma = requiredPrisma();
		const [accounts, projects] = await Promise.all([
			prisma.socialAccount.findMany({
				where: { workspaceId, status: { not: "revoked" } },
				select: { id: true, displayName: true, platform: true },
				orderBy: { displayName: "asc" },
			}),
			prisma.project.findMany({
				where: {
					workspaceId,
					socialPosts: { some: { workspaceId } },
					...accessibleProjectWhere(),
				},
				select: { id: true, title: true },
				orderBy: { title: "asc" },
			}),
		]);
		return { accounts, projects };
	}

	async getCalendarComposerOptions(userId: string, workspaceId: string) {
		await workspaceService.requireActor(
			userId,
			workspaceId,
			"publishing.manage",
		);
		const prisma = requiredPrisma();
		const [clips, accounts] = await Promise.all([
			prisma.clip.findMany({
				where: {
					project: { workspaceId, ...accessibleProjectWhere() },
				},
				select: {
					id: true,
					editorRevision: true,
					title: true,
					hookText: true,
					projectId: true,
					project: { select: { title: true } },
				},
				orderBy: { createdAt: "desc" },
				take: 500,
			}),
			prisma.socialAccount.findMany({
				where: { workspaceId, status: "active" },
				select: { id: true, platform: true, displayName: true, handle: true },
				orderBy: [{ platform: "asc" }, { displayName: "asc" }],
			}),
		]);
		return {
			clips: clips.map((clip) => ({
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
		};
	}
}

export const workspaceLibraryService = new WorkspaceLibraryService();
