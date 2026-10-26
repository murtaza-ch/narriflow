import { createHash } from "node:crypto";
import type { PricingTier, Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { PAID_ACCESS_ENDED_GRACE_DAYS, planLimits } from "@narriflow/validators";
import {
	deleteObject,
	deleteObjects,
	getJsonObject,
	isR2Configured,
	listObjectPageByPrefix,
	listObjectsByPrefix,
	putJson,
	type R2ObjectSummary,
} from "./r2-storage";
import { getWorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { getProcessingUsage } from "./processing-usage-runtime";
import { queueProjectExpiryFinished } from "./operation-finished";
import { flushWorkspaceEvents } from "./workspace-event";

const HOUR_MS = 60 * 60 * 1000;
const freeRetentionHours = planLimits("free").projectRetentionHours;
if (freeRetentionHours === null) {
	throw new Error("The Free plan must define a Project retention period");
}

/** Deadline policies stored on Projects. Durations come from the plan catalog. */
export const RETENTION_POLICIES = {
	free_project_v1: { durationMs: freeRetentionHours * HOUR_MS },
	downgrade_to_free_v1: {
		durationMs: PAID_ACCESS_ENDED_GRACE_DAYS * 24 * HOUR_MS,
	},
} as const;
const PROJECT_PURGE_SETTLEMENT_DELAY_MS = 60_000;

export type RetentionPolicyKey = keyof typeof RETENTION_POLICIES;

export class ProjectExpiredError extends Error {
	readonly code = "PROJECT_EXPIRED";

	constructor() {
		super("Project expired while work was in progress");
		this.name = "ProjectExpiredError";
	}
}

export interface RetentionAssignment {
	retentionPolicyKey: RetentionPolicyKey;
	expiresAt: Date;
}

export type TierRetentionTransition =
	| { kind: "clear_unexpired" }
	| { kind: "assign_downgrade"; assignment: RetentionAssignment }
	| { kind: "none" };

/** A new Project on a plan with a retention period gets its deadline at creation. */
export function retentionAssignmentForNewProject(input: {
	tier: PricingTier;
	createdAt: Date;
}): RetentionAssignment | null {
	const hours = planLimits(input.tier).projectRetentionHours;
	if (hours === null) return null;
	return {
		retentionPolicyKey: "free_project_v1",
		expiresAt: new Date(input.createdAt.getTime() + hours * HOUR_MS),
	};
}

/** Paid access ending starts the download grace; any paid tier clears unexpired deadlines. */
export function retentionTransitionForTierChange(input: {
	previousTier: PricingTier;
	nextTier: PricingTier;
	effectiveAt: Date;
}): TierRetentionTransition {
	if (input.nextTier !== "free") return { kind: "clear_unexpired" };
	if (input.previousTier === "free") return { kind: "none" };
	return {
		kind: "assign_downgrade",
		assignment: {
			retentionPolicyKey: "downgrade_to_free_v1",
			expiresAt: new Date(
				input.effectiveAt.getTime() +
					RETENTION_POLICIES.downgrade_to_free_v1.durationMs,
			),
		},
	};
}

export function isProjectAccessible(
	project: { expiresAt: Date | null; purgeStartedAt?: Date | null },
	now = new Date(),
): boolean {
	return (
		!project.purgeStartedAt &&
		(!project.expiresAt || project.expiresAt.getTime() > now.getTime())
	);
}

export function projectDeletionHash(projectId: string): string {
	return createHash("sha256").update(projectId).digest("hex");
}

export interface ProjectPrefixDeleteDependencies {
	list: (prefix: string, limit: number) => Promise<R2ObjectSummary[]>;
	deleteBatch: (keys: string[]) => Promise<void>;
	onBatchDeleted?: (summary: {
		objectCount: number;
		totalBytes: number;
	}) => Promise<void>;
}

export async function deleteProjectPrefixObjects(
	projectId: string,
	dependencies: ProjectPrefixDeleteDependencies = {
		list: listObjectsByPrefix,
		deleteBatch: deleteObjects,
	},
): Promise<{ objectCount: number; totalBytes: number }> {
	const prefix = `projects/${projectId}/`;
	let objectCount = 0;
	let totalBytes = 0;

	for (;;) {
		const objects = await dependencies.list(prefix, 1000);
		if (objects.length === 0) break;
		await dependencies.deleteBatch(objects.map((object) => object.key));
		const batchBytes = objects.reduce(
			(sum, object) => sum + object.sizeBytes,
			0,
		);
		objectCount += objects.length;
		totalBytes += batchBytes;
		await dependencies.onBatchDeleted?.({
			objectCount: objects.length,
			totalBytes: batchBytes,
		});
	}

	return { objectCount, totalBytes };
}

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function retryDelayMs(attemptCount: number): number {
	if (attemptCount <= 1) return 60_000;
	if (attemptCount === 2) return 5 * 60_000;
	if (attemptCount === 3) return 15 * 60_000;
	return 60 * 60_000;
}

class ProjectPurgeRescuedError extends Error {
	constructor() {
		super("Project purge was cancelled by a pre-deadline upgrade");
		this.name = "ProjectPurgeRescuedError";
	}
}

export interface ExpiringProjectNotificationCandidate {
	id: string;
	title: string;
	expiresAt: Date;
}

export interface RetentionMaintenanceResult {
	warningsDue: ExpiringProjectNotificationCandidate[];
	purged: number;
	failed: number;
	waiting: number;
	receiptsDeleted: number;
}

interface ExternalDeletionTombstone {
	projectIdHash: string;
	retentionPolicyKey: string;
	expiresAt: Date;
	purgeCompletedAt: Date;
	objectCount: number;
	totalBytes: bigint;
	deleteAfter: Date;
	tombstoneStorageKey: string;
}

function parseExternalTombstone(
	value: unknown,
	tombstoneStorageKey: string,
): ExternalDeletionTombstone | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	const expiresAt = new Date(String(row.expiresAt ?? ""));
	const purgeCompletedAt = new Date(String(row.purgeCompletedAt ?? ""));
	const deleteAfter = new Date(String(row.deleteAfter ?? ""));
	if (
		typeof row.projectIdHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(row.projectIdHash) ||
		typeof row.retentionPolicyKey !== "string" ||
		!Number.isFinite(expiresAt.getTime()) ||
		!Number.isFinite(purgeCompletedAt.getTime()) ||
		!Number.isFinite(deleteAfter.getTime())
	) {
		return null;
	}
	try {
		return {
			projectIdHash: row.projectIdHash,
			retentionPolicyKey: row.retentionPolicyKey,
			expiresAt,
			purgeCompletedAt,
			objectCount: Math.max(0, Math.trunc(Number(row.objectCount ?? 0))),
			totalBytes: BigInt(String(row.totalBytes ?? "0")),
			deleteAfter,
			tombstoneStorageKey,
		};
	} catch {
		return null;
	}
}

export class ProjectRetentionService {
	async assignmentForWorkspace(
		workspaceId: string,
		createdAt: Date,
	): Promise<RetentionAssignment | null> {
		const prisma = getPrismaClient();
		if (!prisma) {
			return retentionAssignmentForNewProject({ tier: "free", createdAt });
		}
		const workspace = await prisma.workspace.findUnique({
			where: { id: workspaceId },
			select: { pricingTier: true },
		});
		if (!workspace) throw new Error("Workspace not found");
		return retentionAssignmentForNewProject({
			tier: workspace.pricingTier,
			createdAt,
		});
	}

	async applyWorkspaceTierTransition(
		tx: Prisma.TransactionClient,
		input: {
			workspaceId: string;
			previousTier: PricingTier;
			nextTier: PricingTier;
			effectiveAt: Date;
			observedAt?: Date;
		},
	): Promise<void> {
		const transition = retentionTransitionForTierChange(input);
		if (transition.kind === "clear_unexpired") {
			const rescueCutoff =
				input.observedAt &&
				input.observedAt.getTime() > input.effectiveAt.getTime()
					? input.observedAt
					: input.effectiveAt;
			await tx.project.updateMany({
				where: {
					workspaceId: input.workspaceId,
					expiresAt: { gt: rescueCutoff },
					purgeDeletedObjectCount: 0,
					purgeStorageVerifiedAt: null,
				},
				data: {
					retentionPolicyKey: null,
					expiresAt: null,
					purgeStartedAt: null,
					purgeLeaseExpiresAt: null,
					purgeRetryAt: null,
					purgeStorageVerifiedAt: null,
					purgeLastError: null,
				},
			});
			return;
		}
		if (transition.kind === "assign_downgrade") {
			await tx.project.updateMany({
				where: {
					workspaceId: input.workspaceId,
					purgeStartedAt: null,
					expiresAt: null,
				},
				data: {
					retentionPolicyKey: transition.assignment.retentionPolicyKey,
					expiresAt: transition.assignment.expiresAt,
				},
			});
		}
	}

	async listProjectsNeedingExpiryWarning(
		now = new Date(),
		limit = 100,
	): Promise<ExpiringProjectNotificationCandidate[]> {
		const prisma = getPrismaClient();
		if (!prisma) return [];
		const warningWindowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
		return prisma.project.findMany({
			where: {
				purgeStartedAt: null,
				expiresAt: { gt: now, lte: warningWindowEnd },
				notificationLedgers: {
					none: { outcome: "project_expiring" },
				},
			},
			select: { id: true, title: true, expiresAt: true },
			orderBy: { expiresAt: "asc" },
			take: Math.max(1, Math.min(500, limit)),
		}) as Promise<ExpiringProjectNotificationCandidate[]>;
	}

	async purgeDueProjects(
		limit = 10,
		now = new Date(),
	): Promise<{
		purged: number;
		failed: number;
		waiting: number;
	}> {
		const summary = { purged: 0, failed: 0, waiting: 0 };
		for (let index = 0; index < Math.max(1, Math.min(100, limit)); index += 1) {
			const claimed = await this.claimDueProject(now);
			if (!claimed) break;
			try {
				await getWorkflowRunLifecycle().cancelQueuedProjectRuns({
					projectId: claimed.id,
					errorCode: "PROJECT_EXPIRED",
				});
				const outcome = await this.purgeClaimedProject(claimed);
				if (outcome === "purged") summary.purged += 1;
				else summary.waiting += 1;
			} catch (error) {
				if (error instanceof ProjectPurgeRescuedError) {
					summary.waiting += 1;
					continue;
				}
				summary.failed += 1;
				await this.recordPurgeFailure(
					claimed.id,
					claimed.purgeAttemptCount,
					error,
				);
			}
		}
		return summary;
	}

	private async claimDueProject(now: Date) {
		const prisma = requirePrisma();
		const destructiveCutoff = new Date(
			now.getTime() - PROJECT_PURGE_SETTLEMENT_DELAY_MS,
		);
		const candidate = await prisma.project.findFirst({
			where: {
				expiresAt: { lte: destructiveCutoff },
				OR: [{ purgeRetryAt: null }, { purgeRetryAt: { lte: now } }],
				AND: [
					{
						OR: [
							{ purgeLeaseExpiresAt: null },
							{ purgeLeaseExpiresAt: { lte: now } },
						],
					},
				],
			},
			select: { id: true, purgeStartedAt: true },
			orderBy: { expiresAt: "asc" },
		});
		if (!candidate) return null;

		return prisma.$transaction(async (tx) => {
			const leaseExpiresAt = new Date(now.getTime() + 15 * 60 * 1000);
			const claimed = await tx.project.updateMany({
				where: {
					id: candidate.id,
					expiresAt: { lte: destructiveCutoff },
					OR: [{ purgeRetryAt: null }, { purgeRetryAt: { lte: now } }],
					AND: [
						{
							OR: [
								{ purgeLeaseExpiresAt: null },
								{ purgeLeaseExpiresAt: { lte: now } },
							],
						},
					],
				},
				data: {
					purgeStartedAt: candidate.purgeStartedAt ?? now,
					purgeLeaseExpiresAt: leaseExpiresAt,
					purgeRetryAt: null,
					purgeAttemptCount: { increment: 1 },
					purgeLastError: null,
				},
			});
			if (claimed.count !== 1) return null;

			await Promise.all([
				tx.ingestJob.updateMany({
					where: { projectId: candidate.id, status: "queued" },
					data: {
						status: "cancelled",
						lastError: "PROJECT_EXPIRED",
						completedAt: now,
						sourceCredential: null,
					},
				}),
				tx.transcript.updateMany({
					where: { projectId: candidate.id, status: "queued" },
					data: { status: "failed", errorCode: "PROJECT_EXPIRED" },
				}),
				tx.socialPost.updateMany({
					where: {
						projectId: candidate.id,
						status: { in: ["draft", "scheduled"] },
					},
					data: { status: "cancelled", errorCode: "PROJECT_EXPIRED" },
				}),
				tx.clipExport.updateMany({
					where: { projectId: candidate.id, status: "queued" },
					data: { status: "failed", errorCode: "PROJECT_EXPIRED" },
				}),
			]);

			const claimedProject = await tx.project.findUnique({
				where: { id: candidate.id },
				select: {
					id: true,
					retentionPolicyKey: true,
					expiresAt: true,
					purgeAttemptCount: true,
					purgeDeletedObjectCount: true,
					purgeDeletedBytes: true,
				},
			});
			// Cancelled intakes and failed exports are finished operations too.
			await queueProjectExpiryFinished(tx, candidate.id);
			await flushWorkspaceEvents(tx);
			return claimedProject;
			});
	}

	private async purgeClaimedProject(
		project: NonNullable<
			Awaited<ReturnType<ProjectRetentionService["claimDueProject"]>>
		>,
	): Promise<"purged" | "rescued" | "waiting"> {
		if (!project.expiresAt || !project.retentionPolicyKey) {
			throw new Error("Expired project is missing its retention contract");
		}
		if (!isR2Configured()) {
			throw new Error("R2 configuration is required for irreversible purge");
		}
		const prisma = requirePrisma();
		const stillFenced = await prisma.project.findFirst({
			where: {
				id: project.id,
				purgeStartedAt: { not: null },
				expiresAt: { not: null },
				retentionPolicyKey: { not: null },
			},
			select: { id: true },
		});
		if (!stillFenced) return "rescued";

		// Queued work was cancelled in the claim transaction. Running workers
		// retain their rows until they hit a project/R2 checkpoint and record a
		// terminal state. Keeping those rows visible is the active-writer lease:
		// storage deletion cannot race a worker that has not acknowledged the
		// purge fence yet.
		const activeWorkers = await prisma.project.findFirst({
			where: {
				id: project.id,
				OR: [
					{ ingestJobs: { some: { status: "running" } } },
					{ workflowRuns: { some: { status: "running" } } },
					{
						socialPosts: {
							some: {
								status: {
									in: [
										"publishing",
										"processing",
										"reconciling",
										"needs_attention",
									],
								},
							},
						},
					},
				],
			},
			select: { id: true },
		});
		if (activeWorkers) {
			const retryAt = new Date(Date.now() + 60_000);
			await prisma.project.updateMany({
				where: { id: project.id, purgeStartedAt: { not: null } },
				data: { purgeLeaseExpiresAt: null, purgeRetryAt: retryAt },
			});
			console.warn(
				JSON.stringify({
					level: "info",
					message: "expired_project_waiting_for_active_workers",
					projectIdHash: projectDeletionHash(project.id),
					retryAt: retryAt.toISOString(),
				}),
			);
			return "waiting";
		}

		await deleteProjectPrefixObjects(project.id, {
			list: listObjectsByPrefix,
			deleteBatch: async (keys) => {
				const fence = await prisma.project.findFirst({
					where: { id: project.id, purgeStartedAt: { not: null } },
					select: { id: true },
				});
				if (!fence) throw new ProjectPurgeRescuedError();
				await deleteObjects(keys);
			},
			onBatchDeleted: async (batch) => {
				await prisma.project.updateMany({
					where: { id: project.id },
					data: {
						purgeDeletedObjectCount: { increment: batch.objectCount },
						purgeDeletedBytes: { increment: BigInt(batch.totalBytes) },
						purgeLeaseExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
					},
				});
			},
		});

		const storageVerified = await prisma.project.updateMany({
			where: { id: project.id, purgeStartedAt: { not: null } },
			data: { purgeStorageVerifiedAt: new Date() },
		});
		if (storageVerified.count !== 1) throw new ProjectPurgeRescuedError();

		const aggregate = await prisma.project.findUnique({
			where: { id: project.id },
			select: { purgeDeletedObjectCount: true, purgeDeletedBytes: true },
		});
		if (!aggregate) return "rescued";

		const completedAt = new Date();
		const hash = projectDeletionHash(project.id);
		const tombstoneStorageKey = `retention-receipts/v1/${hash}.json`;
		const deleteAfter = new Date(
			completedAt.getTime() + 90 * 24 * 60 * 60 * 1000,
		);
		const receipt = {
			version: 1,
			projectIdHash: hash,
			retentionPolicyKey: project.retentionPolicyKey,
			expiresAt: project.expiresAt.toISOString(),
			purgeCompletedAt: completedAt.toISOString(),
			objectCount: aggregate.purgeDeletedObjectCount,
			totalBytes: aggregate.purgeDeletedBytes.toString(),
			deleteAfter: deleteAfter.toISOString(),
		};
		await putJson({
			key: tombstoneStorageKey,
			value: receipt,
			metadata: { receipt_version: "1" },
		});

		await prisma.$transaction(async (tx) => {
			// An expired intake that never settled returns its reservation;
			// settled usage survives the purge unchanged. Releasing before the
			// Project row lock keeps the usage-row-then-Project lock order.
			await getProcessingUsage().release(tx, {
				projectId: project.id,
				reason: "project_retention_purged",
			});
			const deleted = await tx.project.deleteMany({
				where: { id: project.id, purgeStartedAt: { not: null } },
			});
			if (deleted.count !== 1) throw new ProjectPurgeRescuedError();
			await tx.projectDeletionReceipt.upsert({
				where: { projectIdHash: hash },
				update: {
					purgeCompletedAt: completedAt,
					objectCount: aggregate.purgeDeletedObjectCount,
					totalBytes: aggregate.purgeDeletedBytes,
					tombstoneStorageKey,
					deleteAfter,
				},
				create: {
					projectIdHash: hash,
					retentionPolicyKey: project.retentionPolicyKey!,
					expiresAt: project.expiresAt!,
					purgeCompletedAt: completedAt,
					objectCount: aggregate.purgeDeletedObjectCount,
					totalBytes: aggregate.purgeDeletedBytes,
					tombstoneStorageKey,
					deleteAfter,
				},
			});
		});

		console.warn(
			JSON.stringify({
				level: "info",
				message: "expired_project_purged",
				projectIdHash: hash,
				objectCount: aggregate.purgeDeletedObjectCount,
				totalBytes: aggregate.purgeDeletedBytes.toString(),
				purgeCompletedAt: completedAt.toISOString(),
			}),
		);
		return "purged";
	}

	private async recordPurgeFailure(
		projectId: string,
		attemptCount: number,
		error: unknown,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const retryAt = new Date(Date.now() + retryDelayMs(attemptCount));
		await requirePrisma().project.updateMany({
			where: { id: projectId },
			data: {
				purgeLeaseExpiresAt: null,
				purgeRetryAt: retryAt,
				purgeLastError: message.slice(0, 1000),
			},
		});
		console.warn(
			JSON.stringify({
				level: attemptCount >= 3 ? "error" : "warn",
				message: "expired_project_purge_failed",
				projectIdHash: projectDeletionHash(projectId),
				attemptCount,
				retryAt: retryAt.toISOString(),
				error: message,
			}),
		);
	}

	async deleteExpiredReceipts(limit = 100, now = new Date()): Promise<number> {
		const prisma = getPrismaClient();
		if (!prisma || !isR2Configured()) return 0;
		const rows = await prisma.projectDeletionReceipt.findMany({
			where: { deleteAfter: { lte: now } },
			orderBy: { deleteAfter: "asc" },
			take: Math.max(1, Math.min(500, limit)),
		});
		let deleted = 0;
		for (const row of rows) {
			await deleteObject(row.tombstoneStorageKey);
			const result = await prisma.projectDeletionReceipt.deleteMany({
				where: { id: row.id, deleteAfter: { lte: now } },
			});
			deleted += result.count;
		}
		return deleted;
	}

	/** Must run before reopening traffic after a database PITR restore. The R2
	 * tombstone ledger is outside the restored database timeline, so it fences
	 * projects whose rows reappeared in the restored snapshot. */
	async replayDeletionTombstones(now = new Date()): Promise<{
		tombstonesRead: number;
		projectsRemoved: number;
		invalidTombstones: number;
	}> {
		if (!isR2Configured()) {
			throw new Error("R2 configuration is required for tombstone replay");
		}
		const prisma = requirePrisma();
		const tombstones = new Map<string, ExternalDeletionTombstone>();
		let continuationToken: string | undefined;
		let invalidTombstones = 0;
		do {
			const page = await listObjectPageByPrefix(
				"retention-receipts/v1/",
				1000,
				continuationToken,
			);
			for (const object of page.objects) {
				const parsed = parseExternalTombstone(
					await getJsonObject({ key: object.key, maxBytes: 32 * 1024 }),
					object.key,
				);
				if (!parsed) {
					invalidTombstones += 1;
					continue;
				}
				if (parsed.deleteAfter.getTime() > now.getTime()) {
					tombstones.set(parsed.projectIdHash, parsed);
				}
			}
			continuationToken = page.nextContinuationToken ?? undefined;
		} while (continuationToken);

		let projectsRemoved = 0;
		let cursor: string | undefined;
		for (;;) {
			const projects = await prisma.project.findMany({
				select: { id: true },
				orderBy: { id: "asc" },
				take: 1000,
				...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			});
			if (projects.length === 0) break;
			for (const project of projects) {
				const tombstone = tombstones.get(projectDeletionHash(project.id));
				if (!tombstone) continue;
				await prisma.$transaction(async (tx) => {
					await tx.projectDeletionReceipt.upsert({
						where: { projectIdHash: tombstone.projectIdHash },
						update: {
							purgeCompletedAt: tombstone.purgeCompletedAt,
							deleteAfter: tombstone.deleteAfter,
							tombstoneStorageKey: tombstone.tombstoneStorageKey,
						},
						create: {
							projectIdHash: tombstone.projectIdHash,
							retentionPolicyKey: tombstone.retentionPolicyKey,
							expiresAt: tombstone.expiresAt,
							purgeCompletedAt: tombstone.purgeCompletedAt,
							objectCount: tombstone.objectCount,
							totalBytes: tombstone.totalBytes,
							tombstoneStorageKey: tombstone.tombstoneStorageKey,
							deleteAfter: tombstone.deleteAfter,
						},
					});
					await tx.project.deleteMany({ where: { id: project.id } });
				});
				projectsRemoved += 1;
			}
			cursor = projects.at(-1)?.id;
			if (projects.length < 1000) break;
		}

		return {
			tombstonesRead: tombstones.size,
			projectsRemoved,
			invalidTombstones,
		};
	}
}

export const projectRetentionService = new ProjectRetentionService();
