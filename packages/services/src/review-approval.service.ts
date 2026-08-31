import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  reviewApprovalRolloutPolicy,
  type ReviewApprovalRolloutPolicy,
} from "./review-rollout";
import { frozenProjectApprovalRequired } from "./review-project-policy";
import { workspaceService } from "./workspace.service";

export type ReviewRoundAccessState = "open" | "expired" | "revoked" | "superseded";
export type ReviewItemDecision = "approved" | "changes_requested" | null;

export interface ReviewApprovalEvidence {
  roundId: string;
  approvalRequired: boolean;
  accessState: ReviewRoundAccessState;
  itemDecision: ReviewItemDecision;
  campaignDecision: ReviewItemDecision;
}

export interface ReviewApprovalPolicySnapshot {
  projectApprovalRequired: boolean;
  exports: Array<{
    exportId: string;
    evidence: ReviewApprovalEvidence[];
  }>;
}

export type ReviewApprovalFailureCode =
  | "review_approval_missing"
  | "review_item_unapproved"
  | "review_campaign_unapproved"
  | "review_changes_requested"
  | "review_round_inactive";

export interface ReviewApprovalItemResult {
  exportId: string;
  eligible: boolean;
  required: boolean;
  code: ReviewApprovalFailureCode | null;
  roundId: string | null;
}

export interface ReviewApprovalEvaluation {
  eligible: boolean;
  items: ReviewApprovalItemResult[];
}

export interface ReviewApprovalWarnOnlyEvent {
  level: "warn";
  message: "review_approval_warn_only";
  workspaceId: string;
  projectId: string;
  requiredExportCount: number;
  blockedExportCount: number;
  failureCodes: ReviewApprovalFailureCode[];
}

function failureForEvidence(
  evidence: ReviewApprovalEvidence[],
): ReviewApprovalFailureCode {
  if (evidence.length === 0) return "review_approval_missing";
  if (
    evidence.some(
      (entry) =>
        entry.accessState === "open" &&
        (entry.itemDecision === "changes_requested" ||
          entry.campaignDecision === "changes_requested"),
    )
  ) {
    return "review_changes_requested";
  }
  if (evidence.every((entry) => entry.accessState !== "open")) {
    return "review_round_inactive";
  }
  if (
    evidence.some(
      (entry) =>
        entry.accessState === "open" && entry.itemDecision === "approved",
    )
  ) {
    return "review_campaign_unapproved";
  }
  return "review_item_unapproved";
}

export function evaluateReviewApproval(
  input: ReviewApprovalPolicySnapshot,
): ReviewApprovalEvaluation {
  const items = input.exports.map<ReviewApprovalItemResult>((item) => {
    const roundRequiresApproval = item.evidence.some(
      (entry) => entry.approvalRequired,
    );
    const required = input.projectApprovalRequired || roundRequiresApproval;
    if (!required) {
      return {
        exportId: item.exportId,
        eligible: true,
        required: false,
        code: null,
        roundId: null,
      };
    }

    const applicableEvidence = item.evidence.filter(
      (entry) => entry.approvalRequired,
    );
    const approved = applicableEvidence.find(
      (entry) =>
        entry.accessState === "open" &&
        entry.itemDecision === "approved" &&
        entry.campaignDecision === "approved",
    );
    if (approved) {
      return {
        exportId: item.exportId,
        eligible: true,
        required: true,
        code: null,
        roundId: approved.roundId,
      };
    }
    return {
      exportId: item.exportId,
      eligible: false,
      required: true,
      code: failureForEvidence(applicableEvidence),
      roundId: applicableEvidence[0]?.roundId ?? null,
    };
  });
  return { eligible: items.every((item) => item.eligible), items };
}

export type ReviewApprovalPrincipal =
  | { kind: "browser"; actorUserId: string }
  | { kind: "api_key"; apiKeyId: string }
  | { kind: "oauth"; clientId: string }
  | { kind: "worker" };

export interface ReviewApprovalOverrideRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  exportIds: string[];
  reason: string;
  createdAt: Date;
}

export interface ReviewApprovalStore {
  readPolicy(input: {
    workspaceId: string;
    projectId: string;
    exportIds: string[];
    now: Date;
  }): Promise<ReviewApprovalPolicySnapshot>;
  openOverride(input: Omit<ReviewApprovalOverrideRecord, "id" | "createdAt"> & {
    id: string;
    now: Date;
  }): Promise<ReviewApprovalOverrideRecord>;
}

export class ReviewApprovalRequiredError extends Error {
  readonly code = "review_approval_required";

  constructor(readonly items: ReviewApprovalItemResult[]) {
    super("The exact Clip Export needs client approval before it can be scheduled");
    this.name = "ReviewApprovalRequiredError";
  }
}

export class ReviewOverrideForbiddenError extends Error {
  readonly code = "review_override_forbidden";

  constructor() {
    super("Only a Workspace owner or admin can override client approval");
    this.name = "ReviewOverrideForbiddenError";
  }
}

export class ReviewApprovalOverrideConflictError extends Error {
  readonly code = "review_override_conflict";

  constructor() {
    super("The override request was already used with different details");
    this.name = "ReviewApprovalOverrideConflictError";
  }
}

export class ReviewApprovalTargetError extends Error {
  readonly code = "review_approval_target_invalid";

  constructor() {
    super("One or more Clip Exports do not belong to this project");
    this.name = "ReviewApprovalTargetError";
  }
}

function overrideFingerprint(input: {
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  exportIds: string[];
  reason: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: "review-approval-override-v1",
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        exportIds: [...input.exportIds].sort(),
        reason: input.reason,
      }),
    )
    .digest("hex");
}

export function createReviewApprovalService(dependencies: {
  store: ReviewApprovalStore;
  authorizeOverride(input: {
    actorUserId: string;
    workspaceId: string;
  }): Promise<void>;
  rolloutPolicy?: ReviewApprovalRolloutPolicy;
  onWarn?: (event: ReviewApprovalWarnOnlyEvent) => void;
  createId?: () => string;
  now?: () => Date;
}) {
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());
  const rolloutPolicy =
    dependencies.rolloutPolicy ?? reviewApprovalRolloutPolicy;
  const onWarn =
    dependencies.onWarn ??
    ((event: ReviewApprovalWarnOnlyEvent) => {
      console.warn(JSON.stringify(event));
    });

  return {
    async inspectProjectPolicy(input: {
      workspaceId: string;
      projectId: string;
    }) {
      const policy = await dependencies.store.readPolicy({
        ...input,
        exportIds: [],
        now: now(),
      });
      return { approvalRequired: policy.projectApprovalRequired };
    },

    async inspectExactExports(input: {
      workspaceId: string;
      projectId: string;
      exportIds: string[];
    }) {
      const exportIds = [...new Set(input.exportIds)].sort();
      if (exportIds.length === 0) throw new ReviewApprovalTargetError();
      const policy = await dependencies.store.readPolicy({
        ...input,
        exportIds,
        now: now(),
      });
      if (
        policy.exports.length !== exportIds.length ||
        policy.exports.some((entry, index) => entry.exportId !== exportIds[index])
      ) {
        throw new ReviewApprovalTargetError();
      }
      return evaluateReviewApproval(policy);
    },

    async authorizeExactExports(input: {
      principal: ReviewApprovalPrincipal;
      workspaceId: string;
      projectId: string;
      exportIds: string[];
      idempotencyKey: string;
      overrideReason: string | null;
    }) {
      const exportIds = [...new Set(input.exportIds)].sort();
      const evaluation = await this.inspectExactExports({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        exportIds,
      });
      const rolloutMode = rolloutPolicy.modeFor({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      });
      if (evaluation.eligible) {
        return {
          ...evaluation,
          overridden: false as const,
          overrideAuditId: null,
        };
      }
      if (rolloutMode === "warn") {
        onWarn({
          level: "warn",
          message: "review_approval_warn_only",
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          requiredExportCount: evaluation.items.filter((item) => item.required)
            .length,
          blockedExportCount: evaluation.items.filter(
            (item) => !item.eligible,
          ).length,
          failureCodes: [
            ...new Set(
              evaluation.items
                .map((item) => item.code)
                .filter(
                  (code): code is ReviewApprovalFailureCode => code !== null,
                ),
            ),
          ].sort(),
        });
        return {
          eligible: true as const,
          items: evaluation.items,
          overridden: false as const,
          overrideAuditId: null,
        };
      }
      const reason = input.overrideReason?.trim() ?? "";
      if (!reason) throw new ReviewApprovalRequiredError(evaluation.items);
      if (reason.length > 500 || input.principal.kind !== "browser") {
        throw new ReviewOverrideForbiddenError();
      }
      await dependencies.authorizeOverride({
        actorUserId: input.principal.actorUserId,
        workspaceId: input.workspaceId,
      });
      const requestFingerprint = overrideFingerprint({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorUserId: input.principal.actorUserId,
        exportIds,
        reason,
      });
      const audit = await dependencies.store.openOverride({
        id: createId(),
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorUserId: input.principal.actorUserId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        exportIds,
        reason,
        now: now(),
      });
      return {
        eligible: true as const,
        items: evaluation.items,
        overridden: true as const,
        overrideAuditId: audit.id,
      };
    },
  };
}

export function createInMemoryReviewApprovalStore(
  snapshot: ReviewApprovalPolicySnapshot,
): ReviewApprovalStore & { countOverrides(): Promise<number> } {
  const overrides = new Map<string, ReviewApprovalOverrideRecord>();
  return {
    async readPolicy(input) {
      const byExport = new Map(
        snapshot.exports.map((entry) => [entry.exportId, entry]),
      );
      return {
        projectApprovalRequired: snapshot.projectApprovalRequired,
        exports: input.exportIds
          .map((exportId) => byExport.get(exportId))
          .filter((entry): entry is ReviewApprovalPolicySnapshot["exports"][number] => Boolean(entry))
          .map((entry) => structuredClone(entry)),
      };
    },
    async openOverride(input) {
      const key = `${input.workspaceId}:${input.idempotencyKey}`;
      const existing = overrides.get(key);
      if (existing) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new ReviewApprovalOverrideConflictError();
        }
        return structuredClone(existing);
      }
      const record: ReviewApprovalOverrideRecord = {
        id: input.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        exportIds: [...input.exportIds],
        reason: input.reason,
        createdAt: input.now,
      };
      overrides.set(key, record);
      return structuredClone(record);
    },
    async countOverrides() {
      return overrides.size;
    },
  };
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function accessStateForRound(
  round: {
    status: string;
    revokedAt: Date | null;
    supersededAt: Date | null;
    expiresAt: Date | null;
  },
  now: Date,
): ReviewRoundAccessState {
  if (round.revokedAt || round.status === "revoked") return "revoked";
  if (round.supersededAt || round.status === "superseded") {
    return "superseded";
  }
  if (round.expiresAt && round.expiresAt <= now) return "expired";
  return "open";
}

export const prismaReviewApprovalStore: ReviewApprovalStore = {
  async readPolicy(input) {
    const prisma = requirePrisma();
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: {
        brandProfileId: true,
        brandProfileSnapshot: true,
      },
    });
    if (!project) return { projectApprovalRequired: false, exports: [] };

    const exports = await prisma.clipExport.findMany({
      where: {
        id: { in: input.exportIds },
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      },
      select: {
        id: true,
        reviewRoundItems: {
          select: {
            currentDecision: true,
            reviewRound: {
              select: {
                id: true,
                approvalRequired: true,
                status: true,
                revokedAt: true,
                supersededAt: true,
                expiresAt: true,
                decision: true,
              },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    });

    return {
      projectApprovalRequired:
        frozenProjectApprovalRequired(project),
      exports: exports.map((clipExport) => ({
        exportId: clipExport.id,
        evidence: clipExport.reviewRoundItems.map((item) => ({
          roundId: item.reviewRound.id,
          approvalRequired: item.reviewRound.approvalRequired,
          accessState: accessStateForRound(item.reviewRound, input.now),
          itemDecision:
            item.currentDecision === "approved" ||
            item.currentDecision === "changes_requested"
              ? item.currentDecision
              : null,
          campaignDecision:
            item.reviewRound.decision === "approved" ||
            item.reviewRound.decision === "changes_requested"
              ? item.reviewRound.decision
              : null,
        })),
      })),
    };
  },

  async openOverride(input) {
    const prisma = requirePrisma();
    const existing = await prisma.reviewApprovalOverride.findUnique({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: input.workspaceId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new ReviewApprovalOverrideConflictError();
      }
      return {
        ...existing,
        exportIds: Array.isArray(existing.exportIds)
          ? existing.exportIds.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
      };
    }

    try {
      const created = await prisma.reviewApprovalOverride.create({
        data: {
          id: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          actorUserId: input.actorUserId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          exportIds: input.exportIds,
          reason: input.reason,
          createdAt: input.now,
        },
      });
      return { ...created, exportIds: [...input.exportIds] };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const replay = await prisma.reviewApprovalOverride.findUnique({
          where: {
            workspaceId_idempotencyKey: {
              workspaceId: input.workspaceId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (replay?.requestFingerprint === input.requestFingerprint) {
          return {
            ...replay,
            exportIds: Array.isArray(replay.exportIds)
              ? replay.exportIds.filter(
                  (entry): entry is string => typeof entry === "string",
                )
              : [],
          };
        }
        throw new ReviewApprovalOverrideConflictError();
      }
      throw error;
    }
  },
};

export const reviewApprovalService = createReviewApprovalService({
  store: prismaReviewApprovalStore,
  authorizeOverride: async ({ actorUserId, workspaceId }) => {
    try {
      await workspaceService.requireActor(
        actorUserId,
        workspaceId,
        "review.override",
      );
    } catch {
      throw new ReviewOverrideForbiddenError();
    }
  },
});
