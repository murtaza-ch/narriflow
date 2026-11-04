import type { PricingTier, Prisma } from "@prisma/client";
import { PAID_ACCESS_ENDED_GRACE_DAYS, planLimits } from "@narriflow/validators";

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

export type RetentionPolicyKey = keyof typeof RETENTION_POLICIES;

/** Marks a purge the user asked for. It has no duration, and no plan change rescues it. */
export const USER_DELETED_RETENTION_POLICY = "user_deleted_v1";

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

export class ProjectRetentionService {
	/** Call under the Workspace usage lock: billing changes a tier under it, so this tier cannot be stale. */
	async assignmentForWorkspace(
		tx: Prisma.TransactionClient,
		workspaceId: string,
		createdAt: Date,
	): Promise<RetentionAssignment | null> {
		const workspace = await tx.workspace.findUnique({
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
					retentionPolicyKey: { not: USER_DELETED_RETENTION_POLICY },
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

}

export const projectRetentionService = new ProjectRetentionService();
