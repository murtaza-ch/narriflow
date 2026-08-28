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
import { structuredSocialPublicationMetrics } from "./social-publication-observability";
import { SOCIAL_PUBLICATION_CAPABILITY_VERSIONS } from "./social-publication-config";
import { socialOAuthService } from "./social-oauth.service";

const DEFAULT_PROCESSING_DEADLINE_MS = 24 * 60 * 60_000;
const DEFAULT_RECONCILIATION_DEADLINE_MS = 24 * 60 * 60_000;

export function allowedSocialPublicationActions(row: {
  status: string;
  errorCode: string | null;
  socialAccount?: { status?: string } | null;
  workspace?: { status?: string } | null;
}): SocialPublicationAction[] {
	const reconnectRequired =
		row.socialAccount?.status !== undefined &&
		row.socialAccount.status !== "active" ||
		row.errorCode === "social_account_reconnect_required" ||
		row.errorCode?.includes("authentication") ||
		row.errorCode?.includes("permission");
  if (
    row.status === "draft" ||
    row.status === "preparing_video" ||
    row.status === "scheduled"
  ) {
    return ["cancel"];
	}
	if (row.status === "needs_attention") {
		if (reconnectRequired) return ["confirm_published", "reconnect_account"];
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
    reconnectRequired
  ) {
    return ["reconnect_account"];
  }
	if (row.status === "posted" && reconnectRequired) {
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

function normalizedHandle(raw: string | null | undefined) {
  return raw?.trim().replace(/^@/, "").toLowerCase() || null;
}

function platformPostReference(platform: SocialPlatform, url: URL) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (platform === "x" && segments[1] === "status" && segments[2]) {
    return { reference: segments[2], owner: normalizedHandle(segments[0]) };
  }
  if (platform === "tiktok" && segments[1] === "video" && segments[2]) {
    return { reference: segments[2], owner: normalizedHandle(segments[0]) };
  }
  if (
    platform === "youtube_shorts" &&
    ((segments[0] === "shorts" && segments[1]) ||
      (segments[0] === "watch" && url.searchParams.get("v")) ||
      (url.hostname.toLowerCase().replace(/^www\./, "") === "youtu.be" && segments[0]))
  ) {
    return {
      reference: segments[0] === "shorts"
        ? segments[1]!
        : url.searchParams.get("v") ?? segments[0]!,
      owner: null,
    };
  }
  if (platform === "instagram_reels" && ["reel", "p"].includes(segments[0] ?? "") && segments[1]) {
    return { reference: segments[1], owner: null };
  }
  if (platform === "linkedin" && segments[0] === "feed" && segments[1] === "update" && segments[2]) {
    return { reference: segments[2], owner: null };
  }
  throw new SocialPublicationRecoveryError(
    "social_publication_reference_invalid",
    "The published URL must identify one post on the selected platform",
  );
}

export async function validateSocialPublicationEvidence(input: {
  platform: SocialPlatform;
  externalUrl: string | null | undefined;
  accountHandle: string | null | undefined;
  accountProviderId?: string | null;
  providerReference?: string | null;
  accessToken?: string | null;
  scopes?: readonly string[];
  validateOwnership?: boolean;
  request?: typeof fetch;
}) {
  const externalUrl = assertPlatformUrl(input.platform, input.externalUrl);
  const fromUrl = externalUrl
    ? platformPostReference(input.platform, new URL(externalUrl))
    : null;
  const accountHandle = normalizedHandle(input.accountHandle);
  if (fromUrl?.owner && accountHandle && fromUrl.owner !== accountHandle) {
    throw new SocialPublicationRecoveryError(
      "social_publication_reference_invalid",
      "The published URL does not belong to the selected social account",
    );
  }
  const reference = input.providerReference ?? fromUrl?.reference ?? null;
  if (
    input.providerReference &&
    fromUrl?.reference &&
    input.providerReference !== fromUrl.reference
  ) {
    throw new SocialPublicationRecoveryError(
      "social_publication_reference_invalid",
      "The platform URL and provider reference identify different posts",
    );
  }
  if (!input.validateOwnership || !reference || !input.accessToken) {
    return { externalUrl, ownershipValidated: false };
  }
  const request = input.request ?? fetch;
	if (input.platform === "youtube_shorts" && input.accountProviderId) {
		const response = await request(
			`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(reference)}`,
			{
				headers: { Authorization: `Bearer ${input.accessToken}` },
				signal: AbortSignal.timeout(10_000),
			},
		).catch(() => null);
		if (response?.ok) {
			const body = (await response.json()) as {
				items?: Array<{ id?: string; snippet?: { channelId?: string } }>;
			};
			const video = body.items?.find((item) => item.id === reference);
			if (video?.snippet?.channelId !== input.accountProviderId) {
				throw new SocialPublicationRecoveryError(
					"social_publication_reference_invalid",
					"The provider reports that this video belongs to another channel",
				);
			}
			return { externalUrl, ownershipValidated: true };
		}
	}
	if (
		input.platform === "instagram_reels" &&
		input.accountProviderId &&
		input.providerReference &&
		/^\d+$/.test(reference)
	) {
		const response = await request(
			`https://graph.facebook.com/${SOCIAL_PUBLICATION_CAPABILITY_VERSIONS.instagram_reels}/${encodeURIComponent(reference)}?${new URLSearchParams({ fields: "id,owner,permalink", access_token: input.accessToken })}`,
			{ signal: AbortSignal.timeout(10_000) },
		).catch(() => null);
		if (response?.ok) {
			const body = (await response.json()) as {
				id?: string;
				owner?: { id?: string };
			};
			if (body.id !== reference || body.owner?.id !== input.accountProviderId) {
				throw new SocialPublicationRecoveryError(
					"social_publication_reference_invalid",
					"The provider reports that this post belongs to another Instagram account",
				);
			}
			return { externalUrl, ownershipValidated: true };
		}
	}
  if (
    input.platform === "x" &&
    input.scopes?.includes("tweet.read") &&
    input.scopes.includes("users.read") &&
    accountHandle
  ) {
    const response = await request(
      `https://api.x.com/2/tweets/${encodeURIComponent(reference)}?expansions=author_id&user.fields=username`,
      {
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    ).catch(() => null);
    if (response?.ok) {
      const body = (await response.json()) as {
        data?: { author_id?: string };
        includes?: { users?: Array<{ id?: string; username?: string }> };
      };
      const author = body.includes?.users?.find(
        (user) => user.id && user.id === body.data?.author_id,
      );
      if (normalizedHandle(author?.username) !== accountHandle) {
        throw new SocialPublicationRecoveryError(
          "social_publication_reference_invalid",
          "The provider reports that this post belongs to another account",
        );
      }
      return { externalUrl, ownershipValidated: true };
    }
  }
  if (
    input.platform === "tiktok" &&
    input.scopes?.includes("video.list")
  ) {
    const response = await request(
      "https://open.tiktokapis.com/v2/video/query/?fields=id",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ filters: { video_ids: [reference] } }),
        signal: AbortSignal.timeout(10_000),
      },
    ).catch(() => null);
    if (response?.ok) {
      const body = (await response.json()) as { data?: { videos?: Array<{ id?: string }> } };
      if (body.data?.videos?.some((video) => video.id === reference) !== true) {
        throw new SocialPublicationRecoveryError(
          "social_publication_reference_invalid",
          "The provider did not find this post on the selected account",
        );
      }
      return { externalUrl, ownershipValidated: true };
    }
  }
  return {
    externalUrl,
    ownershipValidated: false,
  };
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
      socialAccount: { select: { status: true, handle: true } },
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
                providerProcessingStatus: true,
                providerProcessingFailureCode: true,
                providerVisibility: true,
                enrichedAt: true,
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
    const parsed = recheckSocialPublicationSchema.parse({ reason: input.reason });
    const now = input.now ?? new Date();
    const result = await requirePrisma().$transaction(async (tx) => {
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
          phaseStartedAt: now,
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
    structuredSocialPublicationMetrics.observe(
      "social_publication_manual_decisions_total",
      1,
      { decision: "recheck_requested" },
    );
    return result;
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
    const parsed = confirmSocialPublicationSchema.parse({
      reason: input.reason,
      evidenceKind: input.evidenceKind,
      providerReference: input.providerReference,
      externalUrl: input.externalUrl,
    });
    const now = input.now ?? new Date();
    const evidenceTarget = await requirePrisma().socialPost.findFirst({
      where: {
        id: input.socialPostId,
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
      select: {
        platform: true,
        socialAccountId: true,
        socialAccount: { select: { handle: true } },
      },
    });
    if (!evidenceTarget) {
      throw new SocialPublicationRecoveryError(
        "social_publication_not_found",
        "Social publication was not found",
      );
    }
    const account = evidenceTarget.socialAccountId
      ? await socialOAuthService
          .getPublishAccount(evidenceTarget.socialAccountId)
          .catch(() => null)
      : null;
    const evidence = await validateSocialPublicationEvidence({
      platform: evidenceTarget.platform,
      externalUrl: parsed.externalUrl,
      providerReference: parsed.providerReference,
      accountHandle: evidenceTarget.socialAccount?.handle,
      accountProviderId: account?.providerAccountId,
      accessToken: account?.accessToken,
      scopes: account?.scopes,
      validateOwnership: parsed.evidenceKind !== "manual_unvalidated",
    });
	if (
		parsed.evidenceKind !== "manual_unvalidated" &&
		!evidence.ownershipValidated
	) {
		throw new SocialPublicationRecoveryError(
			"social_publication_reference_invalid",
			"Narriflow could not validate this evidence against the selected account; use manual unvalidated evidence to record an explicit operator override",
		);
	}
    const result = await requirePrisma().$transaction(async (tx) => {
      const { post, attempt } = await loadRecoveryTarget(tx, input);
      if (post.status !== "needs_attention" || attempt.phase !== "needs_attention") {
        throw new SocialPublicationRecoveryError(
          "social_publication_transition_conflict",
          "The publication changed before it could be confirmed",
        );
      }
      if (
        post.platform !== evidenceTarget.platform ||
        post.socialAccountId !== evidenceTarget.socialAccountId
      ) {
        throw new SocialPublicationRecoveryError(
          "social_publication_transition_conflict",
          "The publication account changed while evidence was validated",
        );
      }
      const { externalUrl, ownershipValidated } = evidence;
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
          ownershipValidated,
        },
      });
      return {
        socialPostId: post.id,
        attemptId: attempt.id,
        status: "posted" as const,
        evidence: ownershipValidated
          ? ("provider_validated" as const)
          : ("manual" as const),
        ownershipValidated,
        externalUrl,
      };
    });
    structuredSocialPublicationMetrics.observe(
      "social_publication_manual_decisions_total",
      1,
      { decision: "confirmed_published", ownershipValidated: result.ownershipValidated },
    );
    structuredSocialPublicationMetrics.observe(
      "social_publication_receipts_total",
      1,
      { platform: evidenceTarget.platform, source: "manual" },
    );
    return result;
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
    const parsed = republishSocialPublicationSchema.parse({
      reason: input.reason,
      duplicateRiskAcknowledged: input.duplicateRiskAcknowledged,
    });
    const now = input.now ?? new Date();
    const result = await requirePrisma().$transaction(async (tx) => {
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
      const fencedAttempt = await tx.socialPublicationAttempt.updateMany({
        where: { id: attempt.id, phase: "needs_attention" },
        data: { operationLookupHash: null },
      });
      if (fencedAttempt.count !== 1) {
        throw new SocialPublicationRecoveryError(
          "social_publication_transition_conflict",
          "The publication changed before Publish again completed",
        );
      }
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
    structuredSocialPublicationMetrics.observe(
      "social_publication_manual_decisions_total",
      1,
      { decision: "publish_again" },
    );
    return result;
  },
};
