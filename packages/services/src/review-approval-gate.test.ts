import { describe, expect, test } from "bun:test";
import {
	createReviewApprovalGate,
	ReviewApprovalGateError,
	type ReviewApprovalAudit,
	type ReviewApprovalPolicy,
	type ReviewApprovalPrincipal,
} from "./review-approval-gate";

const now = new Date("2026-09-02T10:00:00.000Z");

function policy(
	overrides: Partial<ReviewApprovalPolicy> = {},
): ReviewApprovalPolicy {
	return {
		workspaceId: "workspace-1",
		projectId: "project-1",
		projectApprovalRule: "none",
		latestRound: null,
		...overrides,
	};
}

function round(
	overrides: Partial<NonNullable<ReviewApprovalPolicy["latestRound"]>> = {},
): NonNullable<ReviewApprovalPolicy["latestRound"]> {
	return {
		id: "round-1",
		revision: 1,
		approvalRequired: true,
		status: "open",
		expiresAt: null,
		revokedAt: null,
		supersededAt: null,
		decision: null,
		items: [
			{
				exportId: "export-1",
				required: true,
				currentDecision: null,
			},
		],
		...overrides,
	};
}

function harness(input: {
	policy: ReviewApprovalPolicy;
	allowedOverrideUsers?: string[];
	returnedAuditExportIds?: string[];
}) {
	const audits = new Map<string, ReviewApprovalAudit>();
	const diagnostics: Array<Record<string, unknown>> = [];
	let nextAudit = 1;
	const gate = createReviewApprovalGate({
		loadPolicy: async () => input.policy,
		authorizeOverride: async ({ principal }) => {
			if (
				principal.kind !== "workspace_user" ||
				!(input.allowedOverrideUsers ?? ["owner-1", "admin-1"]).includes(
					principal.userId,
				)
			) {
				throw new ReviewApprovalGateError(
					"review_override_forbidden",
					"Only a Workspace Owner or Admin can override review approval",
				);
			}
		},
		recordOverrides: async ({ exportIds, idempotencyKey, reason, actorUserId }) =>
			(input.returnedAuditExportIds ?? exportIds).map((exportId) => {
				const key = `${idempotencyKey}:${exportId}`;
				const existing = audits.get(key);
				if (existing) return existing;
				const created = {
					id: `audit-${nextAudit++}`,
					exportId,
					actorUserId,
					reason,
					createdAt: now,
				};
				audits.set(key, created);
				return created;
			}),
		recordDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		now: () => now,
	});
	return { gate, audits, diagnostics };
}

const owner: ReviewApprovalPrincipal = {
	kind: "workspace_user",
	userId: "owner-1",
};

const request = {
	principal: owner,
	workspaceId: "workspace-1",
	projectId: "project-1",
	exportIds: ["export-1"],
	idempotencyKey: "schedule-1",
};

describe("ReviewApprovalGate", () => {
	test("leaves advisory projects with no review unchanged", async () => {
		const { gate } = harness({ policy: policy() });

		await expect(gate.authorize(request)).resolves.toMatchObject({
			allowed: true,
			items: [{ exportId: "export-1", eligibility: "advisory" }],
		});
	});

	test("honors the advisory rule frozen by the latest submission", async () => {
		const { gate } = harness({
			policy: policy({
				projectApprovalRule: "approval_required",
				latestRound: round({ approvalRequired: false }),
			}),
		});

		await expect(gate.authorize(request)).resolves.toMatchObject({
			items: [{ exportId: "export-1", eligibility: "advisory" }],
		});
	});

	test("keeps the Brand default for a newer export outside an advisory round", async () => {
		const { gate } = harness({
			policy: policy({
				projectApprovalRule: "approval_required",
				latestRound: round({
					approvalRequired: false,
					items: [
						{
							exportId: "older-export",
							required: true,
							currentDecision: "approved",
						},
					],
				}),
			}),
		});

		await expect(gate.authorize(request)).rejects.toMatchObject({
			code: "review_approval_required",
			details: {
				items: [{ exportId: "export-1", reason: "not_submitted" }],
			},
		});
	});

	test("blocks a required Brand export that has not been submitted", async () => {
		const { gate } = harness({
			policy: policy({ projectApprovalRule: "approval_required" }),
		});

		await expect(gate.authorize(request)).rejects.toMatchObject({
			code: "review_approval_required",
			details: {
				items: [{ exportId: "export-1", reason: "not_submitted" }],
			},
		});
	});

	test("requires every gated export in a multi-export request", async () => {
		const { gate } = harness({
			policy: policy({
				latestRound: round({
					items: [
						{
							exportId: "export-1",
							required: true,
							currentDecision: "approved",
						},
						{
							exportId: "export-2",
							required: true,
							currentDecision: null,
						},
					],
				}),
			}),
		});

		await expect(
			gate.authorize({ ...request, exportIds: ["export-1", "export-2"] }),
		).rejects.toMatchObject({
			code: "review_approval_required",
			details: {
				items: [{ exportId: "export-2", reason: "awaiting_approval" }],
			},
		});
	});

	test("accepts exact approved items and campaign approval", async () => {
		const { gate } = harness({
			policy: policy({
				latestRound: round({
					decision: "approved",
					items: [
						{
							exportId: "export-1",
							required: true,
							currentDecision: "approved",
						},
					],
				}),
			}),
		});

		await expect(gate.authorize(request)).resolves.toMatchObject({
			allowed: true,
			items: [{ exportId: "export-1", eligibility: "approved" }],
		});
	});

	for (const [name, latestRound, reason] of [
		[
			"changes requested",
			round({
				items: [
					{
						exportId: "export-1",
						required: true,
						currentDecision: "changes_requested",
					},
				],
			}),
			"changes_requested",
		],
		[
			"revoked round",
			round({ status: "revoked", revokedAt: now }),
			"round_revoked",
		],
		[
			"expired round",
			round({
				status: "expired",
				expiresAt: new Date("2026-09-02T09:59:59.000Z"),
			}),
			"round_expired",
		],
	] as const) {
		test(`blocks ${name}`, async () => {
			const { gate } = harness({
				policy: policy({ latestRound }),
			});

			await expect(gate.authorize(request)).rejects.toMatchObject({
				code: "review_approval_required",
				details: { items: [{ reason }] },
			});
		});
	}

	test("blocks a campaign-level change request even when the item was approved", async () => {
		const { gate } = harness({
			policy: policy({
				latestRound: round({
					decision: "changes_requested",
					items: [
						{
							exportId: "export-1",
							required: true,
							currentDecision: "approved",
						},
					],
				}),
			}),
		});

		await expect(gate.authorize(request)).rejects.toMatchObject({
			code: "review_approval_required",
			details: {
				items: [{ exportId: "export-1", reason: "changes_requested" }],
			},
		});
	});

	test("never lets approval for an older export authorize a newer export", async () => {
		const { gate } = harness({
			policy: policy({
				latestRound: round({
					items: [
						{
							exportId: "export-old",
							required: true,
							currentDecision: "approved",
						},
					],
				}),
			}),
		});

		await expect(
			gate.authorize({ ...request, exportIds: ["export-new"] }),
		).rejects.toMatchObject({
			code: "review_approval_required",
			details: {
				items: [{ exportId: "export-new", reason: "not_submitted" }],
			},
		});
	});

	test("a resubmission replaces approval from the older round", async () => {
		const { gate } = harness({
			policy: policy({
				latestRound: round({ id: "round-2", revision: 2 }),
			}),
		});

		await expect(gate.authorize(request)).rejects.toMatchObject({
			code: "review_approval_required",
			details: {
				roundId: "round-2",
				items: [{ reason: "awaiting_approval" }],
			},
		});
	});

	for (const principal of [
		{ kind: "workspace_user", userId: "editor-1" },
		{ kind: "workspace_user", userId: "viewer-1" },
		{ kind: "api_key", apiKeyId: "api-key-1" },
		{ kind: "worker", workerId: "worker-1" },
	] satisfies ReviewApprovalPrincipal[]) {
		test(`rejects override by ${principal.kind === "workspace_user" ? principal.userId : principal.kind}`, async () => {
			const { gate } = harness({
				policy: policy({ projectApprovalRule: "approval_required" }),
			});

			await expect(
				gate.authorize({
					...request,
					principal,
					overrideReason: "Legal approved an urgent release.",
				}),
			).rejects.toMatchObject({ code: "review_override_forbidden" });
		});
	}

	for (const userId of ["owner-1", "admin-1"]) {
		test(`allows ${userId} to override only the blocked exports`, async () => {
			const { gate, audits } = harness({
				policy: policy({
					latestRound: round({
						items: [
							{
								exportId: "export-1",
								required: true,
								currentDecision: "approved",
							},
							{
								exportId: "export-2",
								required: true,
								currentDecision: null,
							},
						],
					}),
				}),
			});
			const overrideRequest = {
				...request,
				principal: { kind: "workspace_user" as const, userId },
				exportIds: ["export-1", "export-2"],
				overrideReason: "Legal approved an urgent release.",
			};

			const first = await gate.authorize(overrideRequest);
			const replay = await gate.authorize(overrideRequest);

			expect(first).toEqual(replay);
			expect(first.items).toEqual([
				{ exportId: "export-1", eligibility: "approved", overrideAuditId: null },
				{ exportId: "export-2", eligibility: "overridden", overrideAuditId: "audit-1" },
			]);
			expect(audits.size).toBe(1);
		});
	}

	test("fails closed when the audit adapter returns the wrong export", async () => {
		const { gate } = harness({
			policy: policy({ projectApprovalRule: "approval_required" }),
			returnedAuditExportIds: ["different-export"],
		});

		await expect(
			gate.authorize({
				...request,
				overrideReason: "The client approved this release out of band.",
			}),
		).rejects.toMatchObject({ code: "review_override_audit_incomplete" });
	});
});
