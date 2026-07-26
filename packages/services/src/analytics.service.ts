import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  recordAnalyticsEventSchema,
  type AnalyticsEventType,
  type AnalyticsSnapshot,
  type RecordAnalyticsEventInput,
  type SocialPlatform,
} from "@narriflow/validators";

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
  async recordProjectEvent(input: {
    projectId: string;
    clipId?: string | null;
    type: AnalyticsEventType;
    platform?: SocialPlatform | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const prisma = requirePrisma();
    await prisma.projectAnalyticsEvent.create({
      data: {
        projectId: input.projectId,
        clipId: input.clipId ?? null,
        type: toEventType(input.type),
        platform: input.platform ?? null,
        metadata: input.metadata
          ? (input.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  }

  async recordForOwnedProject(
    userId: string,
    projectId: string,
    input: RecordAnalyticsEventInput,
  ): Promise<void> {
    const parsed = recordAnalyticsEventSchema.parse(input);
    const prisma = requirePrisma();
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
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

    await this.recordProjectEvent({
      projectId,
      clipId: parsed.clipId ?? null,
      type: parsed.type,
      platform: parsed.platform ?? null,
      metadata: parsed.metadata,
    });
  }

  async getProjectAnalytics(
    userId: string,
    projectId: string,
  ): Promise<AnalyticsSnapshot> {
    const prisma = requirePrisma();
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });
    if (!project) {
      throw new Error("project not found");
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

    return {
      projectId,
      totals,
      byClip: [...byClipMap.values()],
    };
  }
}

export const analyticsService = new AnalyticsService();
