import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandProgramAnalyticsEventSchema,
  campaignCompletionIntervalReportSchema,
  generatedMediaAnalyticsEventSchema,
  recordAnalyticsEventSchema,
  type AnalyticsEventType,
  type AnalyticsSnapshot,
  type BrandProgramAnalyticsEventInput,
  type CampaignCompletionIntervalReport,
  type GeneratedMediaAnalyticsEventInput,
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
  async recordGeneratedMediaEvent(
    input: GeneratedMediaAnalyticsEventInput,
  ): Promise<void> {
    const parsed = generatedMediaAnalyticsEventSchema.parse(input);
    await this.recordProjectEvent({
      projectId: parsed.projectId,
      clipId: parsed.clipId ?? null,
      type: parsed.type,
      metadata: parsed.metadata,
    });
  }

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

  async getCampaignCompletionIntervalReport(input: {
    windowStart: Date;
    windowEnd: Date;
    workspaceIds?: readonly string[];
  }): Promise<CampaignCompletionIntervalReport> {
    if (
      !Number.isFinite(input.windowStart.getTime()) ||
      !Number.isFinite(input.windowEnd.getTime()) ||
      input.windowStart >= input.windowEnd
    ) {
      throw new RangeError("Campaign completion report window must move forward");
    }
    const workspaceIds = input.workspaceIds
      ? [...new Set(input.workspaceIds)]
      : null;
    if (
      workspaceIds &&
      (workspaceIds.length === 0 ||
        workspaceIds.length > 500 ||
        workspaceIds.some(
          (workspaceId) =>
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              workspaceId,
            ),
        ))
    ) {
      throw new RangeError(
        "Campaign completion report workspace cohort must contain 1-500 UUIDs",
      );
    }
    const prisma = requirePrisma();
    const events = await prisma.projectAnalyticsEvent.findMany({
      where: {
        type: { in: ["clips_ready", "campaign_scheduled"] },
        createdAt: { gte: input.windowStart, lt: input.windowEnd },
        ...(workspaceIds
          ? { project: { workspaceId: { in: workspaceIds } } }
          : {}),
      },
      select: {
        id: true,
        projectId: true,
        type: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const readyAtByProject = new Map<string, Date>();
    for (const event of events) {
      if (event.type !== "clips_ready" || readyAtByProject.has(event.projectId)) {
        continue;
      }
      readyAtByProject.set(event.projectId, event.createdAt);
    }
    const firstScheduleByProject = new Map<
      string,
      { createdAt: Date; scheduledCount: number; approvalOverrides: number }
    >();
    for (const event of events) {
      if (
        event.type !== "campaign_scheduled" ||
        firstScheduleByProject.has(event.projectId)
      ) {
        continue;
      }
      const readyAt = readyAtByProject.get(event.projectId);
      if (!readyAt || event.createdAt < readyAt) continue;
      const metadata =
        event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
          ? event.metadata
          : null;
      const scheduledCount = metadata?.scheduledCount;
      const approvalOverrides = metadata?.approvalOverrides ?? 0;
      if (
        typeof scheduledCount !== "number" ||
        !Number.isSafeInteger(scheduledCount) ||
        scheduledCount <= 0 ||
        typeof approvalOverrides !== "number" ||
        !Number.isSafeInteger(approvalOverrides) ||
        approvalOverrides < 0
      ) {
        continue;
      }
      firstScheduleByProject.set(event.projectId, {
        createdAt: event.createdAt,
        scheduledCount,
        approvalOverrides,
      });
    }
    const durations = [...firstScheduleByProject.entries()]
      .map(([projectId, schedule]) =>
        (schedule.createdAt.getTime() - readyAtByProject.get(projectId)!.getTime()) /
        1_000,
      )
      .sort((left, right) => left - right);
    const percentile = (values: readonly number[], fraction: number) => {
      if (values.length === 0) return null;
      const position = (values.length - 1) * fraction;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      const lowerValue = values[lower]!;
      const upperValue = values[upper]!;
      return lowerValue + (upperValue - lowerValue) * (position - lower);
    };

    const scheduledProjectIds = [...firstScheduleByProject.keys()];
    const [reviewRounds, publicationAttemptRows, generatedJobRows] =
      await Promise.all([
        scheduledProjectIds.length === 0
          ? Promise.resolve([])
          : prisma.reviewRound.findMany({
              where: {
                projectId: { in: scheduledProjectIds },
                sentAt: { lt: input.windowEnd },
              },
              select: { projectId: true, revision: true, sentAt: true },
            }),
        prisma.socialPublicationAttempt.findMany({
          where: {
            terminalAt: { gte: input.windowStart, lt: input.windowEnd },
            phase: { in: ["succeeded", "failed", "needs_attention"] },
            ...(workspaceIds
              ? { socialPost: { workspaceId: { in: workspaceIds } } }
              : {}),
          },
          select: {
            phase: true,
            socialPost: { select: { platform: true } },
          },
        }),
        prisma.generatedMediaJob.findMany({
          where: {
            completedAt: { gte: input.windowStart, lt: input.windowEnd },
            status: { in: ["completed", "failed", "rejected"] },
            ...(workspaceIds ? { workspaceId: { in: workspaceIds } } : {}),
          },
          select: { provider: true, kind: true, status: true },
        }),
      ]);

    const reviewRevisionByProject = new Map<string, number>();
    for (const round of reviewRounds) {
      const scheduledAt = firstScheduleByProject.get(round.projectId)?.createdAt;
      if (!scheduledAt || round.sentAt > scheduledAt) continue;
      reviewRevisionByProject.set(
        round.projectId,
        Math.max(reviewRevisionByProject.get(round.projectId) ?? 0, round.revision),
      );
    }
    const reviewRevisionCounts = scheduledProjectIds
      .map((projectId) => reviewRevisionByProject.get(projectId) ?? 0)
      .sort((left, right) => left - right);

    const publicationSummary = (rows: typeof publicationAttemptRows) => {
      const succeeded = rows.filter((row) => row.phase === "succeeded").length;
      const failed = rows.filter((row) => row.phase === "failed").length;
      const needsAttention = rows.filter(
        (row) => row.phase === "needs_attention",
      ).length;
      const terminal = succeeded + failed + needsAttention;
      return {
        terminal,
        succeeded,
        failed,
        needsAttention,
        failureRate: terminal === 0 ? 0 : (failed + needsAttention) / terminal,
      };
    };
    const publicationByPlatform = new Map<
      (typeof publicationAttemptRows)[number]["socialPost"]["platform"],
      typeof publicationAttemptRows
    >();
    for (const row of publicationAttemptRows) {
      const rows = publicationByPlatform.get(row.socialPost.platform) ?? [];
      rows.push(row);
      publicationByPlatform.set(row.socialPost.platform, rows);
    }

    const generatedSummary = (rows: typeof generatedJobRows) => {
      const completed = rows.filter((row) => row.status === "completed").length;
      const failed = rows.filter((row) => row.status === "failed").length;
      const rejected = rows.filter((row) => row.status === "rejected").length;
      const terminal = completed + failed + rejected;
      return {
        terminal,
        completed,
        failed,
        rejected,
        failureRate: terminal === 0 ? 0 : failed / terminal,
        rejectionRate: terminal === 0 ? 0 : rejected / terminal,
      };
    };
    const generatedByProviderKind = new Map<string, typeof generatedJobRows>();
    for (const row of generatedJobRows) {
      const key = `${row.provider}\u0000${row.kind}`;
      const rows = generatedByProviderKind.get(key) ?? [];
      rows.push(row);
      generatedByProviderKind.set(key, rows);
    }

    const eligibleProjects = readyAtByProject.size;
    const scheduledProjects = firstScheduleByProject.size;
    const scheduleValues = [...firstScheduleByProject.values()];
    const overriddenProjects = scheduleValues.filter(
      (schedule) => schedule.approvalOverrides > 0,
    ).length;
    return campaignCompletionIntervalReportSchema.parse({
      windowStart: input.windowStart.toISOString(),
      windowEnd: input.windowEnd.toISOString(),
      eligibleProjects,
      scheduledProjects,
      completionRate:
        eligibleProjects === 0 ? 0 : scheduledProjects / eligibleProjects,
      scheduledDeliverables: [...firstScheduleByProject.values()].reduce(
        (total, schedule) => total + schedule.scheduledCount,
        0,
      ),
      approvalOverrides: scheduleValues.reduce(
        (total, schedule) => total + schedule.approvalOverrides,
        0,
      ),
      overriddenProjects,
      approvalOverrideProjectRate:
        scheduledProjects === 0 ? 0 : overriddenProjects / scheduledProjects,
      durationSeconds: {
        median: percentile(durations, 0.5),
        p90: percentile(durations, 0.9),
      },
      reviewRevisions: {
        projectsWithRounds: reviewRevisionByProject.size,
        median: percentile(reviewRevisionCounts, 0.5),
        p90: percentile(reviewRevisionCounts, 0.9),
      },
      publicationAttempts: {
        ...publicationSummary(publicationAttemptRows),
        byPlatform: [...publicationByPlatform.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([platform, rows]) => ({
            platform,
            ...publicationSummary(rows),
          })),
      },
      generatedProviderOutcomes: {
        ...generatedSummary(generatedJobRows),
        byProviderKind: [...generatedByProviderKind.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, rows]) => {
            const [providerAlias, kind] = key.split("\u0000") as [
              string,
              "image" | "video",
            ];
            return {
              providerAlias,
              kind,
              ...generatedSummary(rows),
            };
          }),
      },
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
