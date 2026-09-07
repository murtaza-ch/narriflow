import { createHash } from "node:crypto";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

export type ReviewApprovalPrincipal =
	| { kind: "workspace_user"; userId: string }
	| { kind: "api_key"; apiKeyId: string }
	| { kind: "worker"; workerId: string };

export type ReviewApprovalPolicy = {
	workspaceId: string;
	projectId: string;
	projectApprovalRule: "none" | "approval_required";
	latestRound: {
		id: string;
		revision: number;
		approvalRequired: boolean;
		status: string;
		expiresAt: Date | null;
		revokedAt: Date | null;
		supersededAt: Date | null;
		decision: string | null;
		items: Array<{
			exportId: string;
			required: boolean;
			currentDecision: string | null;
		}>;
	} | null;
};

export type ReviewApprovalBlockReason =
	| "not_submitted"
	| "awaiting_approval"
	| "changes_requested"
	| "round_revoked"
	| "round_expired"
	| "round_superseded";

export type ReviewApprovalAudit = {
	id: string;
	exportId: string;
	actorUserId: string;
	reason: string;
	createdAt: Date;
};

export type ReviewApprovalResult = {
	allowed: true;
	items: Array<{
		exportId: string;
		eligibility: "advisory" | "approved" | "overridden";
		overrideAuditId: string | null;
	}>;
};

type BlockedItem = {
	exportId: string;
	reason: ReviewApprovalBlockReason;
};

const REVIEW_APPROVAL_FAILURES = {
  review_approval_policy_mismatch: "conflict",
  review_approval_policy_invalid: "unavailable",
  review_approval_required: "conflict",
  review_export_not_found: "missing",
  review_exports_required: "invalid",
  review_override_audit_incomplete: "unavailable",
  review_override_forbidden: "forbidden",
  review_override_reason_invalid: "invalid",
  review_override_conflict: "conflict",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type ReviewApprovalGateErrorCode = keyof typeof REVIEW_APPROVAL_FAILURES;

export class ReviewApprovalGateError extends ExpectedDomainFailureError<
  ReviewApprovalGateErrorCode,
  { roundId: string | null; items: BlockedItem[] }
> {
	constructor(
		code: ReviewApprovalGateErrorCode,
		message: string,
		details?: {
			roundId: string | null;
			items: BlockedItem[];
		},
	) {
		super({ code, kind: REVIEW_APPROVAL_FAILURES[code], message, details });
		this.name = "ReviewApprovalGateError";
	}
}

export function createReviewApprovalGate(dependencies: {
	loadPolicy(input: {
		workspaceId: string;
		projectId: string;
		exportIds: string[];
	}): Promise<ReviewApprovalPolicy>;
	authorizeOverride(input: {
		principal: ReviewApprovalPrincipal;
		workspaceId: string;
	}): Promise<void>;
	recordOverrides(input: {
		workspaceId: string;
		projectId: string;
		exportIds: string[];
		idempotencyKey: string;
		requestFingerprint: string;
		actorUserId: string;
		reason: string;
		roundId: string | null;
		createdAt: Date;
	}): Promise<ReviewApprovalAudit[]>;
	recordDiagnostic(input: {
		outcome: "allowed" | "blocked" | "overridden";
		workspaceId: string;
		projectId: string;
		roundId: string | null;
		exportIds: string[];
		blocked: BlockedItem[];
	}): void;
	now(): Date;
}) {
	return {
		async authorize(input: {
			principal: ReviewApprovalPrincipal;
			workspaceId: string;
			projectId: string;
			exportIds: string[];
			idempotencyKey: string;
			overrideReason?: string | null;
		}): Promise<ReviewApprovalResult> {
			const exportIds = [...new Set(input.exportIds)];
			if (exportIds.length === 0) {
				throw new ReviewApprovalGateError(
					"review_exports_required",
					"At least one Clip Export is required for approval",
				);
			}
			const policy = await dependencies.loadPolicy({
				workspaceId: input.workspaceId,
				projectId: input.projectId,
				exportIds,
			});
			if (
				policy.workspaceId !== input.workspaceId ||
				policy.projectId !== input.projectId
			) {
				throw new ReviewApprovalGateError(
					"review_approval_policy_mismatch",
					"Review approval policy does not match this project",
				);
			}

			const now = dependencies.now();
			const evaluation = exportIds.map((exportId) =>
				evaluateExport(policy, exportId, now),
			);
			const blocked = evaluation.flatMap((item) =>
				item.reason ? [{ exportId: item.exportId, reason: item.reason }] : [],
			);
			if (blocked.length === 0) {
				dependencies.recordDiagnostic({
					outcome: "allowed",
					workspaceId: input.workspaceId,
					projectId: input.projectId,
					roundId: policy.latestRound?.id ?? null,
					exportIds,
					blocked,
				});
				return {
					allowed: true,
					items: evaluation.map((item) => ({
						exportId: item.exportId,
						eligibility: item.eligibility,
						overrideAuditId: null,
					})),
				};
			}

			const reason = input.overrideReason?.trim() ?? "";
			if (input.overrideReason !== undefined && input.overrideReason !== null) {
				if (reason.length === 0 || reason.length > 500) {
					throw new ReviewApprovalGateError(
						"review_override_reason_invalid",
						"Enter an override reason between 1 and 500 characters",
					);
				}
				await dependencies.authorizeOverride({
					principal: input.principal,
					workspaceId: input.workspaceId,
				});
				if (input.principal.kind !== "workspace_user") {
					throw new ReviewApprovalGateError(
						"review_override_forbidden",
						"Only a Workspace Owner or Admin can override review approval",
					);
				}
				const requestFingerprint = createHash("sha256")
					.update(
						JSON.stringify({
							contract: "review-approval-override-v1",
							workspaceId: input.workspaceId,
							projectId: input.projectId,
							exportIds: blocked.map((item) => item.exportId).sort(),
							actorUserId: input.principal.userId,
							reason,
							roundId: policy.latestRound?.id ?? null,
						}),
					)
					.digest("hex");
				const audits = await dependencies.recordOverrides({
					workspaceId: input.workspaceId,
					projectId: input.projectId,
					exportIds: blocked.map((item) => item.exportId),
					idempotencyKey: input.idempotencyKey,
					requestFingerprint,
					actorUserId: input.principal.userId,
					reason,
					roundId: policy.latestRound?.id ?? null,
					createdAt: now,
				});
				const auditByExport = new Map(
					audits.map((audit) => [audit.exportId, audit]),
				);
				const exactAuditCoverage =
					auditByExport.size === blocked.length &&
					blocked.every((item) => Boolean(auditByExport.get(item.exportId)?.id));
				if (!exactAuditCoverage) {
					throw new ReviewApprovalGateError(
						"review_override_audit_incomplete",
						"Review approval override could not be audited",
					);
				}
				dependencies.recordDiagnostic({
					outcome: "overridden",
					workspaceId: input.workspaceId,
					projectId: input.projectId,
					roundId: policy.latestRound?.id ?? null,
					exportIds,
					blocked,
				});
				return {
					allowed: true,
					items: evaluation.map((item) => ({
						exportId: item.exportId,
						eligibility: item.reason ? "overridden" : item.eligibility,
						overrideAuditId: item.reason
							? (auditByExport.get(item.exportId)?.id ?? null)
							: null,
					})),
				};
			}

			dependencies.recordDiagnostic({
				outcome: "blocked",
				workspaceId: input.workspaceId,
				projectId: input.projectId,
				roundId: policy.latestRound?.id ?? null,
				exportIds,
				blocked,
			});
			throw new ReviewApprovalGateError(
				"review_approval_required",
				"This exact Clip Export needs review approval before publishing",
				{
					roundId: policy.latestRound?.id ?? null,
					items: blocked,
				},
			);
		},
	};
}

function evaluateExport(
	policy: ReviewApprovalPolicy,
	exportId: string,
	now: Date,
): {
	exportId: string;
	eligibility: "advisory" | "approved";
	reason: ReviewApprovalBlockReason | null;
} {
	const round = policy.latestRound;
	const item = round?.items.find((candidate) => candidate.exportId === exportId);
	const gated = item
		? Boolean(round?.approvalRequired && item.required)
		: policy.projectApprovalRule === "approval_required" ||
			Boolean(round?.approvalRequired);
	if (!gated) return { exportId, eligibility: "advisory", reason: null };
	if (!round || !item) {
		return { exportId, eligibility: "advisory", reason: "not_submitted" };
	}
	if (round.revokedAt !== null || round.status === "revoked") {
		return { exportId, eligibility: "advisory", reason: "round_revoked" };
	}
	if (
		round.expiresAt !== null &&
		round.expiresAt.getTime() <= now.getTime()
	) {
		return { exportId, eligibility: "advisory", reason: "round_expired" };
	}
	if (round.supersededAt !== null || round.status === "superseded") {
		return { exportId, eligibility: "advisory", reason: "round_superseded" };
	}
	if (
		round.decision === "changes_requested" ||
		item.currentDecision === "changes_requested"
	) {
		return { exportId, eligibility: "advisory", reason: "changes_requested" };
	}
	if (
		round.status === "open" &&
		item.currentDecision === "approved"
	) {
		return { exportId, eligibility: "approved", reason: null };
	}
	return { exportId, eligibility: "advisory", reason: "awaiting_approval" };
}
