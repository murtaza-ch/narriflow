import { workspaceService } from "./workspace.service";
import { combineLatestCaptures, latestCaptureInclude } from "./performance-summary";
import { accessibleProjectWhere } from "./project-access";
import type { ActorScope } from "./actor-scope";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandProgramAnalyticsEventSchema,
  recordAnalyticsEventSchema,
  type AnalyticsEventType,
  type AnalyticsSnapshot,
  type BrandProgramAnalyticsEventInput,
  type RecordAnalyticsEventInput,
  type SocialPlatform,
} from "@narriflow/validators";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

const analyticsFailureCatalog = {
  analytics_clip_not_found: "missing",
  analytics_project_not_found: "missing",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type AnalyticsFailureCode = keyof typeof analyticsFailureCatalog;

export class AnalyticsServiceError extends ExpectedDomainFailureError<AnalyticsFailureCode> {
  constructor(code: AnalyticsFailureCode, message: string) {
    super({ code, kind: analyticsFailureCatalog[code], message });
    this.name = "AnalyticsServiceError";
  }
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable");
  }
  return prisma;
}

function toEventType(type: AnalyticsEventType) {
  return type;
}

export class AnalyticsService {
  async recordBrandProgramEvent(
    input: BrandProgramAnalyticsEventInput,
  ): Promise<void> {
    const parsed = brandProgramAnalyticsEventSchema.parse(input);
    const prisma = requirePrisma();
    await prisma.programAnalyticsEvent.create({
      data: {
        workspaceId: parsed.workspaceId,
        actorUserId: parsed.actorUserId,
        projectId: parsed.projectId ?? null,
        type: parsed.type,
        metadata: parsed.metadata as Prisma.InputJsonValue,
      },
    });
  }

  async recordBrandProgramEventBestEffort(
    input: BrandProgramAnalyticsEventInput,
  ): Promise<void> {
    try {
      await this.recordBrandProgramEvent(input);
    } catch {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "brand_program_analytics_record_failed",
          workspaceId: input.workspaceId,
          eventType: input.type,
        }),
      );
    }
  }

  async recordProjectEvent(input: {
    projectId: string;
    clipId?: string | null;
    type: AnalyticsEventType;
    platform?: SocialPlatform | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const parsed = recordAnalyticsEventSchema.parse({
      type: input.type,
      clipId: input.clipId,
      platform: input.platform,
      metadata: input.metadata,
    });
    const prisma = requirePrisma();
    await prisma.projectAnalyticsEvent.create({
      data: {
        projectId: input.projectId,
        clipId: parsed.clipId ?? null,
        type: toEventType(parsed.type),
        platform: parsed.platform ?? null,
        metadata: parsed.metadata
          ? (parsed.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  }

  async recordForProject(
    scope: ActorScope,
    projectId: string,
    input: RecordAnalyticsEventInput,
  ): Promise<void> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const parsed = recordAnalyticsEventSchema.parse(input);
    const prisma = requirePrisma();
    const project = await prisma.project.findFirst({
      where: { id: projectId, workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
      select: { id: true },
    });
    if (!project) {
      throw new AnalyticsServiceError(
        "analytics_project_not_found",
        "Project not found.",
      );
    }

    if (parsed.clipId) {
      const clip = await prisma.clip.findFirst({
        where: { id: parsed.clipId, projectId },
        select: { id: true },
      });
      if (!clip) {
        throw new AnalyticsServiceError(
          "analytics_clip_not_found",
          "Clip not found.",
        );
      }
    }

    await this.recordProjectEvent({
      projectId,
      clipId: parsed.clipId ?? null,
      type: parsed.type,
      platform: parsed.platform ?? null,
      metadata: parsed.metadata,
    });
  }

  async getProjectAnalytics(
    scope: ActorScope,
    projectId: string,
  ): Promise<AnalyticsSnapshot> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const prisma = requirePrisma();
    const project = await prisma.project.findFirst({
      where: { id: projectId, workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
      select: { id: true },
    });
    if (!project) {
      throw new AnalyticsServiceError(
        "analytics_project_not_found",
        "Project not found.",
      );
    }

    const grouped = await prisma.projectAnalyticsEvent.groupBy({
      by: ["clipId", "type"],
      where: { projectId },
      _count: { _all: true },
    });

    const totals = {
      rendersCompleted: 0,
      downloadsOpened: 0,
      socialScheduled: 0,
      socialPosted: 0,
      socialFailed: 0,
      dubsCompleted: 0,
      dubDownloadsOpened: 0,
    };
    const byClipMap = new Map<
      string,
      {
        clipId: string;
        rendersCompleted: number;
        downloadsOpened: number;
        socialScheduled: number;
        socialPosted: number;
        socialFailed: number;
        dubsCompleted: number;
        dubDownloadsOpened: number;
      }
    >();

    for (const entry of grouped) {
      const count = entry._count._all;
      if (entry.type === "render_completed") totals.rendersCompleted += count;
      if (entry.type === "download_opened") totals.downloadsOpened += count;
      if (entry.type === "social_scheduled") totals.socialScheduled += count;
      if (entry.type === "social_posted") totals.socialPosted += count;
      if (entry.type === "social_failed") totals.socialFailed += count;
      if (entry.type === "dub_completed") totals.dubsCompleted += count;
      if (entry.type === "dub_download_opened") {
        totals.dubDownloadsOpened += count;
      }

      if (!entry.clipId) continue;
      const existing =
        byClipMap.get(entry.clipId) ??
        {
          clipId: entry.clipId,
          rendersCompleted: 0,
          downloadsOpened: 0,
          socialScheduled: 0,
          socialPosted: 0,
          socialFailed: 0,
          dubsCompleted: 0,
          dubDownloadsOpened: 0,
        };
      if (entry.type === "render_completed") existing.rendersCompleted += count;
      if (entry.type === "download_opened") existing.downloadsOpened += count;
      if (entry.type === "social_scheduled") existing.socialScheduled += count;
      if (entry.type === "social_posted") existing.socialPosted += count;
      if (entry.type === "social_failed") existing.socialFailed += count;
      if (entry.type === "dub_completed") existing.dubsCompleted += count;
      if (entry.type === "dub_download_opened") {
        existing.dubDownloadsOpened += count;
      }
      byClipMap.set(entry.clipId, existing);
    }

    // Aggregated in the query so the totals cover every post, not one page.
    const [measured] = await prisma.$queryRaw<
      Array<{
        videos: number;
        views: bigint;
        likes: bigint;
        comments: bigint;
        shares: bigint;
      }>
    >`
      SELECT COUNT(*)::int AS videos,
        COALESCE(SUM(newest."views"), 0)::bigint AS views,
        COALESCE(SUM(newest."likes"), 0)::bigint AS likes,
        COALESCE(SUM(newest."comments"), 0)::bigint AS comments,
        COALESCE(SUM(newest."shares"), 0)::bigint AS shares
      FROM (
        SELECT DISTINCT ON (c."trackedVideoId") c."views", c."likes", c."comments", c."shares"
        FROM "PerformanceCapture" c
        JOIN "TrackedVideo" tv ON tv."id" = c."trackedVideoId"
        JOIN "SocialPost" sp ON sp."id" = tv."socialPostId"
        WHERE sp."projectId" = ${projectId}::uuid AND c."state" = 'captured'
        ORDER BY c."trackedVideoId", c."capturedAt" DESC
      ) newest`;
    const posted = await prisma.socialPost.findMany({
      where: { projectId, workspaceId: scope.workspaceId, status: "posted" },
      orderBy: [{ postedAt: "desc" }, { id: "desc" }],
      take: 100,
      select: {
        id: true,
        clipId: true,
        platform: true,
        postedAt: true,
        trackedVideos: latestCaptureInclude,
      },
    });

    return {
      projectId,
      totals,
      byClip: [...byClipMap.values()],
      postPerformance: {
        measuredVideos: measured?.videos ?? 0,
        totals: {
          views: Number(measured?.views ?? 0),
          likes: Number(measured?.likes ?? 0),
          comments: Number(measured?.comments ?? 0),
          shares: Number(measured?.shares ?? 0),
        },
        posts: posted.map((post) => ({
          socialPostId: post.id,
          clipId: post.clipId,
          platform: post.platform,
          postedAt: post.postedAt?.toISOString() ?? null,
          latestMetrics: combineLatestCaptures(post.trackedVideos),
        })),
      },
    };
  }
}

export const analyticsService = new AnalyticsService();
