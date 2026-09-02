import { getPrismaClient } from "@narriflow/db/client";
import { brandProfileSnapshotSchema } from "@narriflow/validators";
import {
	createReviewApprovalGate,
	ReviewApprovalGateError,
	type ReviewApprovalPolicy,
} from "./review-approval-gate";
import { workspaceService } from "./workspace.service";

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

export function createProductionReviewApprovalGate() {
	return createReviewApprovalGate({
		async loadPolicy({ workspaceId, projectId, exportIds }) {
			const project = await requirePrisma().project.findFirst({
				where: { id: projectId, workspaceId },
				select: {
					id: true,
					workspaceId: true,
					brandProfileSnapshot: true,
					clipExports: {
						where: { id: { in: exportIds } },
						select: { id: true },
					},
					reviewRounds: {
						orderBy: { revision: "desc" },
						take: 1,
						select: {
							id: true,
							revision: true,
							approvalRequired: true,
							status: true,
							expiresAt: true,
							revokedAt: true,
							supersededAt: true,
							decision: true,
							items: {
								where: { exportId: { in: exportIds } },
								select: {
									exportId: true,
									required: true,
									currentDecision: true,
								},
							},
						},
					},
				},
			});
			if (!project || project.clipExports.length !== exportIds.length) {
				throw new ReviewApprovalGateError(
					"review_export_not_found",
					"One or more Clip Exports are not available in this project",
				);
			}
			const snapshot = brandProfileSnapshotSchema.safeParse(
				project.brandProfileSnapshot,
			);
			if (project.brandProfileSnapshot !== null && !snapshot.success) {
				throw new ReviewApprovalGateError(
					"review_approval_policy_invalid",
					"The project's frozen Brand approval policy is invalid",
				);
			}
			return {
				workspaceId: project.workspaceId,
				projectId: project.id,
				projectApprovalRule: snapshot.success
					? snapshot.data.approvalRule
					: "none",
				latestRound: project.reviewRounds[0] ?? null,
			} satisfies ReviewApprovalPolicy;
		},
		async authorizeOverride({ principal, workspaceId }) {
			if (principal.kind !== "workspace_user") {
				throw new ReviewApprovalGateError(
					"review_override_forbidden",
					"Only a Workspace Owner or Admin can override review approval",
				);
			}
			try {
				await workspaceService.requireActor(
					principal.userId,
					workspaceId,
					"review.override",
				);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "Forbidden") {
					throw error;
				}
				throw new ReviewApprovalGateError(
					"review_override_forbidden",
					"Only a Workspace Owner or Admin can override review approval",
				);
			}
		},
		async recordOverrides(input) {
			return requirePrisma().$transaction(async (tx) => {
				const audits = [];
				for (const exportId of input.exportIds) {
					const audit = await tx.reviewApprovalOverride.upsert({
						where: {
							workspaceId_clientIdempotencyKey_exportId: {
								workspaceId: input.workspaceId,
								clientIdempotencyKey: input.idempotencyKey,
								exportId,
							},
						},
						update: {},
						create: {
							workspaceId: input.workspaceId,
							projectId: input.projectId,
							exportId,
							reviewRoundId: input.roundId,
							actorUserId: input.actorUserId,
							clientIdempotencyKey: input.idempotencyKey,
							requestFingerprint: input.requestFingerprint,
							reason: input.reason,
							createdAt: input.createdAt,
						},
						select: {
							id: true,
							exportId: true,
							actorUserId: true,
							reason: true,
							createdAt: true,
							requestFingerprint: true,
						},
					});
					if (audit.requestFingerprint !== input.requestFingerprint) {
						throw new ReviewApprovalGateError(
							"review_override_conflict",
							"This override key is already bound to different approval evidence",
						);
					}
					audits.push({
						id: audit.id,
						exportId: audit.exportId,
						actorUserId: audit.actorUserId,
						reason: audit.reason,
						createdAt: audit.createdAt,
					});
				}
				return audits;
			});
		},
		recordDiagnostic(input) {
			console.warn(
				JSON.stringify({
					level: "info",
					message: "review_approval_gate_evaluated",
					...input,
				}),
			);
		},
		now: () => new Date(),
	});
}

export const reviewApprovalGate = createProductionReviewApprovalGate();
