import { randomUUID } from "node:crypto";
import { Prisma, type SocialPlatform } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  confirmSocialPublicationSchema,
  recheckSocialPublicationSchema,
  republishSocialPublicationSchema,
  type ConfirmSocialPublicationInput,
  type RecheckSocialPublicationInput,
  type RepublishSocialPublicationInput,
  type SocialPublicationAction,
} from "@narriflow/validators";

const DEFAULT_PROCESSING_DEADLINE_MS = 24 * 60 * 60_000;
const DEFAULT_RECONCILIATION_DEADLINE_MS = 24 * 60 * 60_000;

export function allowedSocialPublicationActions(row: {
  status: string;
  errorCode: string | null;
  socialAccount?: { status?: string } | null;
  workspace?: { status?: string } | null;
}): SocialPublicationAction[] {
  if (
    row.status === "draft" ||
    row.status === "preparing_video" ||
    row.status === "scheduled"
  ) {
    return ["cancel"];
  }
  if (row.status === "needs_attention") {
    const actions: SocialPublicationAction[] = ["confirm_published"];
    if (row.socialAccount?.status === "active") actions.unshift("recheck");
    if (
      row.socialAccount?.status === "active" &&
      row.workspace?.status === "active"
    ) {
      actions.push("publish_again");
    } else if (row.socialAccount && row.socialAccount.status !== "active") {
      actions.push("reconnect_account");
    }
    return actions;
  }
  if (
    row.status === "failed" &&
    (row.errorCode === "social_account_reconnect_required" ||
      row.errorCode?.includes("authentication") ||
      row.errorCode?.includes("permission"))
  ) {
    return ["reconnect_account"];
  }
  return row.status === "failed" ? ["schedule_again"] : [];
}

export class SocialPublicationRecoveryError extends Error {
  constructor(
    readonly code:
      | "social_publication_not_found"
      | "social_publication_transition_conflict"
      | "social_publication_recheck_unavailable"
      | "social_publication_republish_blocked"
      | "social_publication_reference_invalid",
    message: string,
  ) {
    super(message);
    this.name = "SocialPublicationRecoveryError";
  }
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function assertPlatformUrl(platform: SocialPlatform, raw: string | null | undefined) {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SocialPublicationRecoveryError(
      "social_publication_reference_invalid",
      "The published URL is not valid",
    );
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const hosts: Record<SocialPlatform, readonly string[]> = {
    youtube_shorts: ["youtube.com", "youtu.be"],
    instagram_reels: ["instagram.com"],
    tiktok: ["tiktok.com"],
    linkedin: ["linkedin.com"],
    x: ["x.com", "twitter.com"],
  };
  if (url.protocol !== "https:" || !hosts[platform].includes(host)) {
    throw new SocialPublicationRecoveryError(
      "social_publication_reference_invalid",
      `The published URL must point to the selected ${platform} account`,
    );
  }
  return url.toString();
}

async function loadRecoveryTarget(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; projectId?: string; socialPostId: string },
) {
  const post = await tx.socialPost.findFirst({
    where: {
      id: input.socialPostId,
      workspaceId: input.workspaceId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    include: {
      workspace: { select: { status: true } },
      socialAccount: { select: { status: true } },
      frozenState: true,
      publicationAttempts: {
        orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
        take: 1,
        include: { receipt: true },
      },
    },
  });
  const attempt = post?.publicationAttempts[0];
  if (!post || !attempt || !post.frozenState) {
    throw new SocialPublicationRecoveryError(
      "social_publication_not_found",
      "Social publication was not found",
    );
  }
  return { post, attempt, frozen: post.frozenState };
}

export const socialPublicationRecovery = {
  async inspect(input: {
    workspaceId: string;
    projectId?: string;
    socialPostId: string;
  }) {
    const post = await requirePrisma().socialPost.findFirst({
      where: {
        id: input.socialPostId,
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
      select: {
        id: true,
        projectId: true,
        platform: true,
        status: true,
        scheduledFor: true,
        postedAt: true,
        externalUrl: true,
        errorCode: true,
        errorDisposition: true,
        nextAttemptAt: true,
        workspace: { select: { status: true } },
        socialAccount: { select: { status: true } },
        publicationAttempts: {
          orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
          select: {
            id: true,
            attemptNumber: true,
            priorAttemptId: true,
            phase: true,
            outcome: true,
            failureCode: true,
            failureDisposition: true,
            nextActionAt: true,
            providerCallCount: true,
            startedAt: true,
            terminalAt: true,
            receipt: {
              select: {
                platformPostId: true,
                externalUrl: true,
                createdAt: true,
              },
            },
            manualDecisions: {
              orderBy: { createdAt: "desc" },
              select: {
                kind: true,
                reason: true,
                evidenceKind: true,
                ownershipValidated: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });
    if (!post) {
      throw new SocialPublicationRecoveryError(
        "social_publication_not_found",
        "Social publication was not found",
      );
    }
    const { workspace, socialAccount, ...facts } = post;
    return {
      ...facts,
      allowedActions: allowedSocialPublicationActions({
        ...post,
        workspace,
        socialAccount,
      }),
    };
  },

  async recheck(
    input: {
      workspaceId: string;
      projectId?: string;
      actorUserId: string;
      socialPostId: string;
      now?: Date;
    } & RecheckSocialPublicationInput,
  ) {
    const parsed = recheckSocialPublicationSchema.parse(input);
    const now = input.now ?? new Date();
    return requirePrisma().$transaction(async (tx) => {
      const { post, attempt } = await loadRecoveryTarget(tx, input);
      if (
        post.status !== "needs_attention" ||
        attempt.phase !== "needs_attention" ||
        post.socialAccount?.status !== "active"
      ) {
        throw new SocialPublicationRecoveryError(
          "social_publication_recheck_unavailable",
          "This publication can no longer be rechecked with the existing provider operation",
        );
      }
      const updatedPost = await tx.socialPost.updateMany({
        where: { id: post.id, status: "needs_attention" },
        data: { status: "reconciling", nextAttemptAt: now },
      });
      const updatedAttempt = await tx.socialPublicationAttempt.updateMany({
        where: { id: attempt.id, phase: "needs_attention" },
        data: {
          phase: "reconciling",
          outcome: "unknown",
          nextActionAt: now,
          terminalAt: null,
        },
      });
      if (updatedPost.count !== 1 || updatedAttempt.count !== 1) {
        throw new SocialPublicationRecoveryError(
          "social_publication_transition_conflict",
          "The publication changed while the recheck was requested",
        );
      }
      await tx.publicationManualDecision.create({
        data: {
          socialPostId: post.id,
          attemptId: attempt.id,
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          kind: "recheck_requested",
          reason: parsed.reason,
        },
      });
      return { socialPostId: post.id, attemptId: attempt.id, status: "reconciling" as const };
    });
  },

  async confirmPublished(
    input: {
      workspaceId: string;
      projectId?: string;
      actorUserId: string;
      socialPostId: string;
      now?: Date;
    } & ConfirmSocialPublicationInput,
  ) {
    const parsed = confirmSocialPublicationSchema.parse(input);
    const now = input.now ?? new Date();
    return requirePrisma().$transaction(async (tx) => {
      const { post, attempt } = await loadRecoveryTarget(tx, input);
      if (post.status !== "needs_attention" || attempt.phase !== "needs_attention") {
        throw new SocialPublicationRecoveryError(
          "social_publication_transition_conflict",
          "The publication changed before it could be confirmed",
        );
      }
      const externalUrl = assertPlatformUrl(post.platform, parsed.externalUrl);
      const decisionId = randomUUID();
      const receiptId = `manual:${decisionId}`;
      const updatedPost = await tx.socialPost.updateMany({
        where: { id: post.id, status: "needs_attention" },
        data: {
          status: "posted",
          postedAt: now,
          externalUrl,
          errorCode: null,
          errorDisposition: null,
          nextAttemptAt: null,
        },
      });
      const updatedAttempt = await tx.socialPublicationAttempt.updateMany({
        where: { id: attempt.id, phase: "needs_attention" },
        data: {
          phase: "succeeded",
          outcome: "accepted",
          failureCode: null,
          failureDisposition: null,
          terminalAt: now,
        },
      });
      if (updatedPost.count !== 1 || updatedAttempt.count !== 1) {
        throw new SocialPublicationRecoveryError(
          "social_publication_transition_conflict",
          "The publication changed before it could be confirmed",
        );
      }
      await tx.providerReceipt.create({
        data: {
          attemptId: attempt.id,
          platform: post.platform,
          receiptId,
          platformPostId: parsed.providerReference ?? null,
          externalUrl,
          metrics: Prisma.JsonNull,
        },
      });
      await tx.publicationAnalyticsIntent.upsert({
        where: { attemptId: attempt.id },
        create: {
          attemptId: attempt.id,
          socialPostId: post.id,
          projectId: post.projectId,
          kind: "social_posted_manual",
          payload: { evidenceKind: parsed.evidenceKind },
          deliveredAt: now,
        },
        update: {},
      });
      await tx.projectAnalyticsEvent.create({
        data: {
          projectId: post.projectId,
          clipId: post.clipId,
          type: "social_posted",
          platform: post.platform,
          metadata: {
            socialPostId: post.id,
            attemptId: attempt.id,
            evidenceKind: parsed.evidenceKind,
            manuallyConfirmed: true,
          },
        },
      });
      await tx.publicationManualDecision.create({
        data: {
          id: decisionId,
          socialPostId: post.id,
          attemptId: attempt.id,
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          kind: "confirmed_published",
          reason: parsed.reason,
          evidenceKind: parsed.evidenceKind,
          providerReference: parsed.providerReference ?? null,
          externalUrl,
          ownershipValidated: false,
        },
      });
      return {
        socialPostId: post.id,
        attemptId: attempt.id,
        status: "posted" as const,
        evidence: "manual" as const,
        externalUrl,
      };
    });
  },

  async publishAgain(
    input: {
      workspaceId: string;
      projectId?: string;
      actorUserId: string;
      socialPostId: string;
      now?: Date;
    } & RepublishSocialPublicationInput,
  ) {
    const parsed = republishSocialPublicationSchema.parse(input);
    const now = input.now ?? new Date();
    return requirePrisma().$transaction(async (tx) => {
      const { post, attempt, frozen } = await loadRecoveryTarget(tx, input);
      if (
        post.status !== "needs_attention" ||
        attempt.phase !== "needs_attention" ||
        post.workspace?.status !== "active" ||
        post.socialAccount?.status !== "active"
      ) {
        throw new SocialPublicationRecoveryError(
          "social_publication_republish_blocked",
          "Publishing again is blocked until the workspace and social account are active",
        );
      }
      const decisionId = randomUUID();
      const nextAttemptId = randomUUID();
      const updated = await tx.socialPost.updateMany({
        where: { id: post.id, status: "needs_attention" },
        data: {
          status: "scheduled",
          errorCode: null,
          errorDisposition: null,
          nextAttemptAt: now,
        },
      });
      if (updated.count !== 1) {
        throw new SocialPublicationRecoveryError(
          "social_publication_transition_conflict",
          "The publication changed before Publish again completed",
        );
      }
      await tx.socialPublicationAttempt.create({
        data: {
          id: nextAttemptId,
          socialPostId: post.id,
          frozenStateId: frozen.id,
          attemptNumber: attempt.attemptNumber + 1,
          priorAttemptId: attempt.id,
          idempotencyKey: `${attempt.idempotencyKey}:manual:${decisionId}`,
          phase: "retry_scheduled",
          nextActionAt: now,
          processingDeadline: new Date(now.getTime() + DEFAULT_PROCESSING_DEADLINE_MS),
          reconciliationDeadline: new Date(
            now.getTime() + DEFAULT_RECONCILIATION_DEADLINE_MS,
          ),
        },
      });
      await tx.publicationManualDecision.create({
        data: {
          id: decisionId,
          socialPostId: post.id,
          attemptId: attempt.id,
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          kind: "republish_requested",
          reason: parsed.reason,
        },
      });
      return {
        socialPostId: post.id,
        priorAttemptId: attempt.id,
        attemptId: nextAttemptId,
        status: "scheduled" as const,
      };
    });
  },
};
