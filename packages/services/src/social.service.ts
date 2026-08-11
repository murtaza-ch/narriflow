import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  clipAspectRatioToDb,
  scheduleSocialPostSchema,
  socialPostMetricsSchema,
  type ScheduleSocialPostInput,
  type SocialPostMetricsInput,
  type SocialPostSnapshot,
} from "@narriflow/validators";
import { analyticsService } from "./analytics.service";
import { accessibleProjectWhere } from "./project-retention.service";

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable");
  }
  return prisma;
}

function toSocialPostSnapshot(row: {
  id: string;
  projectId: string;
  clipId: string | null;
  socialAccountId?: string | null;
  socialAccount?: {
    displayName: string;
    handle: string | null;
  } | null;
  platform: string;
  status: string;
  caption: string;
  aspectRatio: string | null;
  scheduledFor: Date | null;
  postedAt: Date | null;
  externalUrl: string | null;
  errorCode: string | null;
  metrics?: Array<{
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    watchTimeSeconds: number | null;
    capturedAt: Date;
  }>;
  createdAt: Date;
}): SocialPostSnapshot {
  const aspectRatio =
    row.aspectRatio === "ratio_9_16"
      ? "9:16"
      : row.aspectRatio === "ratio_1_1"
        ? "1:1"
        : row.aspectRatio === "ratio_16_9"
          ? "16:9"
          : row.aspectRatio === "ratio_4_5"
            ? "4:5"
            : null;

  return {
    id: row.id,
    projectId: row.projectId,
    clipId: row.clipId,
    accountId: row.socialAccountId ?? null,
    accountDisplayName: row.socialAccount?.displayName ?? null,
    accountHandle: row.socialAccount?.handle ?? null,
    platform: row.platform as SocialPostSnapshot["platform"],
    status: row.status as SocialPostSnapshot["status"],
    caption: row.caption,
    aspectRatio,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    postedAt: row.postedAt?.toISOString() ?? null,
    externalUrl: row.externalUrl,
    errorCode: row.errorCode,
    latestMetrics: row.metrics?.[0]
      ? {
          views: row.metrics[0].views,
          likes: row.metrics[0].likes,
          comments: row.metrics[0].comments,
          shares: row.metrics[0].shares,
          saves: row.metrics[0].saves,
          watchTimeSeconds: row.metrics[0].watchTimeSeconds,
          capturedAt: row.metrics[0].capturedAt.toISOString(),
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type ClaimedSocialPost = Prisma.SocialPostGetPayload<{
  include: {
    project: { select: { id: true; userId: true; title: true } };
    clip: { include: { renders: true } };
    socialAccount: true;
  };
}>;

export class SocialService {
  async listProjectPosts(
    userId: string,
    projectId: string,
  ): Promise<SocialPostSnapshot[]> {
    const prisma = requirePrisma();
    const rows = await prisma.socialPost.findMany({
      where: { projectId, project: { userId } },
      orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
      include: {
        socialAccount: { select: { displayName: true, handle: true } },
        metrics: {
          orderBy: { capturedAt: "desc" },
          take: 1,
        },
      },
    });
    return rows.map(toSocialPostSnapshot);
  }

  async schedulePost(
    userId: string,
    projectId: string,
    input: ScheduleSocialPostInput,
  ): Promise<SocialPostSnapshot> {
    const parsed = scheduleSocialPostSchema.parse(input);
    const prisma = requirePrisma();

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId, ...accessibleProjectWhere() },
      select: { id: true },
    });
    if (!project) {
      throw new Error("project not found");
    }

    if (parsed.clipId) {
      const clip = await prisma.clip.findFirst({
        where: { id: parsed.clipId, projectId },
        select: { id: true },
      });
      if (!clip) {
        throw new Error("clip not found");
      }
    }

    if (parsed.accountId) {
      const account = await prisma.socialAccount.findFirst({
        where: {
          id: parsed.accountId,
          userId,
          platform: parsed.platform,
          status: { not: "revoked" },
        },
        select: { id: true, status: true },
      });
      if (!account) {
        throw new Error("social account not found for platform");
      }
      if (account.status === "expired") {
        throw new Error("social account token expired");
      }
    }

    const row = await prisma.socialPost.create({
      data: {
        projectId,
        clipId: parsed.clipId ?? null,
        socialAccountId: parsed.accountId ?? null,
        platform: parsed.platform,
        status: "scheduled",
        caption: parsed.caption,
        aspectRatio: parsed.aspectRatio
          ? clipAspectRatioToDb[parsed.aspectRatio]
          : null,
        scheduledFor: parsed.scheduledFor
          ? new Date(parsed.scheduledFor)
          : new Date(),
        metadata: parsed.metadata
          ? (parsed.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });

    await analyticsService.recordProjectEvent({
      projectId,
      clipId: parsed.clipId ?? null,
      type: "social_scheduled",
      platform: parsed.platform,
      metadata: parsed.metadata,
    });

    const withAccount = await prisma.socialPost.findUnique({
      where: { id: row.id },
      include: {
        socialAccount: { select: { displayName: true, handle: true } },
        metrics: {
          orderBy: { capturedAt: "desc" },
          take: 1,
        },
      },
    });

    return toSocialPostSnapshot(withAccount ?? row);
  }

  async cancelPost(
    userId: string,
    projectId: string,
    postId: string,
  ): Promise<SocialPostSnapshot> {
    const prisma = requirePrisma();
    const existing = await prisma.socialPost.findFirst({
      where: { id: postId, projectId, project: { userId } },
    });
    if (!existing) {
      throw new Error("social post not found");
    }
    if (existing.status !== "draft" && existing.status !== "scheduled") {
      throw new Error("only draft or scheduled social posts can be cancelled");
    }

    const cancelled = await prisma.socialPost.updateMany({
      where: { id: postId, status: { in: ["draft", "scheduled"] } },
      data: { status: "cancelled" },
    });
    if (cancelled.count === 0) {
      throw new Error("social post is already being published");
    }

    await analyticsService.recordProjectEvent({
      projectId,
      clipId: existing.clipId,
      type: "social_cancelled",
      platform: existing.platform,
    });

    const row = await prisma.socialPost.findUnique({
      where: { id: postId },
      include: {
        socialAccount: { select: { displayName: true, handle: true } },
        metrics: {
          orderBy: { capturedAt: "desc" },
          take: 1,
        },
      },
    });
    if (!row) {
      throw new Error("social post not found");
    }

    return toSocialPostSnapshot(row);
  }

  async claimDuePosts(limit = 5): Promise<ClaimedSocialPost[]> {
    const prisma = requirePrisma();
    const due = await prisma.socialPost.findMany({
      where: {
        status: "scheduled",
        project: accessibleProjectWhere(),
        OR: [{ scheduledFor: { lte: new Date() } }, { scheduledFor: null }],
      },
      orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
      take: Math.max(1, Math.min(25, limit)),
    });

    const claimed: ClaimedSocialPost[] = [];

    for (const post of due) {
      const updated = await prisma.socialPost.updateMany({
        where: {
          id: post.id,
          status: "scheduled",
          project: accessibleProjectWhere(),
        },
        data: { status: "publishing" },
      });

      if (updated.count === 0) continue;

      const row = await prisma.socialPost.findUnique({
        where: { id: post.id },
      include: {
        project: { select: { id: true, userId: true, title: true } },
        clip: { include: { renders: true } },
        socialAccount: true,
      },
    });

      if (row) claimed.push(row);
    }

    return claimed;
  }

  async completePublishedPost(
    postId: string,
    input: {
      externalUrl?: string | null;
      metrics?: SocialPostMetricsInput | null;
      metadata?: Record<string, unknown> | null;
    },
  ) {
    const prisma = requirePrisma();
    const existing = input.metadata
      ? await prisma.socialPost.findUnique({
          where: { id: postId },
          select: { metadata: true },
        })
      : null;
    const existingMetadata =
      existing?.metadata &&
      typeof existing.metadata === "object" &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    const row = await prisma.socialPost.update({
      where: { id: postId },
      data: {
        status: "posted",
        postedAt: new Date(),
        externalUrl: input.externalUrl ?? null,
        errorCode: null,
        ...(input.metadata
          ? {
              metadata: {
                ...existingMetadata,
                publish: input.metadata,
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
    });

    await analyticsService.recordProjectEvent({
      projectId: row.projectId,
      clipId: row.clipId,
      type: "social_posted",
      platform: row.platform,
    });

    if (input.metrics) {
      return this.recordMetricsForPostId(row.id, input.metrics);
    }

    return toSocialPostSnapshot(row);
  }

  async failPublishingPost(postId: string, errorCode: string) {
    const prisma = requirePrisma();
    const row = await prisma.socialPost.update({
      where: { id: postId },
      data: {
        status: "failed",
        errorCode,
      },
    });

    await analyticsService.recordProjectEvent({
      projectId: row.projectId,
      clipId: row.clipId,
      type: "social_failed",
      platform: row.platform,
      metadata: { errorCode },
    });

    return toSocialPostSnapshot(row);
  }

  /**
   * Fails social posts stuck in `publishing` past the stall timeout (the worker
   * that claimed them likely crashed mid-publish). Mirrors the workflow/ingest
   * reapers: only touches rows older than the cutoff and guards each update with
   * a conditional `status: "publishing"` check. Returns the number reaped.
   */
  async reapStuckPublishingPosts(stallTimeoutMs: number): Promise<number> {
    const prisma = requirePrisma();
    const cutoff = new Date(Date.now() - stallTimeoutMs);
    const stuck = await prisma.socialPost.findMany({
      where: { status: "publishing", updatedAt: { lt: cutoff } },
      select: { id: true },
    });
    let reaped = 0;
    for (const post of stuck) {
      const res = await prisma.socialPost.updateMany({
        where: { id: post.id, status: "publishing" },
        data: { status: "failed", errorCode: "worker_stalled" },
      });
      if (res.count > 0) reaped += 1;
    }
    return reaped;
  }

  async recordPostMetrics(
    userId: string,
    projectId: string,
    postId: string,
    input: SocialPostMetricsInput,
  ) {
    const prisma = requirePrisma();
    const post = await prisma.socialPost.findFirst({
      where: { id: postId, projectId, project: { userId } },
      select: { id: true },
    });
    if (!post) {
      throw new Error("social post not found");
    }

    return this.recordMetricsForPostId(post.id, input);
  }

  async recordMetricsForPostId(postId: string, input: SocialPostMetricsInput) {
    const parsed = socialPostMetricsSchema.parse(input);
    const prisma = requirePrisma();
    const post = await prisma.socialPost.findUnique({
      where: { id: postId },
      select: { id: true, projectId: true, platform: true },
    });
    if (!post) {
      throw new Error("social post not found");
    }

    await prisma.socialPostMetric.create({
      data: {
        projectId: post.projectId,
        postId: post.id,
        platform: post.platform,
        views: parsed.views,
        likes: parsed.likes,
        comments: parsed.comments,
        shares: parsed.shares,
        saves: parsed.saves,
        watchTimeSeconds: parsed.watchTimeSeconds ?? null,
        capturedAt: parsed.capturedAt ? new Date(parsed.capturedAt) : new Date(),
        metadata: parsed.metadata
          ? (parsed.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });

    const updated = await prisma.socialPost.findUnique({
      where: { id: post.id },
      include: {
        socialAccount: { select: { displayName: true, handle: true } },
        metrics: {
          orderBy: { capturedAt: "desc" },
          take: 1,
        },
      },
    });

    if (!updated) {
      throw new Error("social post not found");
    }

    return toSocialPostSnapshot(updated);
  }
}

export const socialService = new SocialService();
