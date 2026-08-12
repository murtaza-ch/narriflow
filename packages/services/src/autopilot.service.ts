import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  autopilotRuleInputSchema,
  autopilotRuleUpdateSchema,
  parseStoredContentPack,
  type AutopilotRuleInput,
  type AutopilotRuleSnapshot,
  type AutopilotRuleUpdate,
} from "@narriflow/validators";
import { fetchRssEpisodes } from "./rss";
import { projectService } from "./project.service";

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable");
  }
  return prisma;
}

function nextRunFrom(intervalMinutes: number) {
  return new Date(Date.now() + intervalMinutes * 60 * 1000);
}

function toSnapshot(row: {
  id: string;
  userId: string;
  name: string;
  rssUrl: string;
  titlePrefix: string | null;
  brandTemplateId: string | null;
  languageCode: string | null;
  contentPack: unknown;
  intervalMinutes: number;
  maxEpisodesPerRun: number;
  status: string;
  lastCheckedAt: Date | null;
  nextRunAt: Date;
  lastError: string | null;
  createdAt: Date;
  _count?: { episodes: number };
}): AutopilotRuleSnapshot {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    rssUrl: row.rssUrl,
    titlePrefix: row.titlePrefix,
    brandTemplateId: row.brandTemplateId,
    languageCode: row.languageCode,
    contentPack: parseStoredContentPack(row.contentPack),
    intervalMinutes: row.intervalMinutes,
    maxEpisodesPerRun: row.maxEpisodesPerRun,
    status: row.status as AutopilotRuleSnapshot["status"],
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt.toISOString(),
    lastError: row.lastError,
    importedEpisodeCount: row._count?.episodes ?? 0,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AutopilotService {
  async listRules(userId: string, workspaceId?: string): Promise<AutopilotRuleSnapshot[]> {
    const prisma = requirePrisma();
    const rows = await prisma.autopilotRule.findMany({
      where: workspaceId ? { workspaceId } : { userId },
      include: { _count: { select: { episodes: true } } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toSnapshot);
  }

  async createRule(
    userId: string,
    input: AutopilotRuleInput,
    context?: { workspaceId: string; actorUserId: string },
  ): Promise<AutopilotRuleSnapshot> {
    const parsed = autopilotRuleInputSchema.parse(input);
    const prisma = requirePrisma();
    const row = await prisma.autopilotRule.create({
      data: {
        userId,
        workspaceId: context?.workspaceId ?? null,
        createdByUserId: context?.actorUserId ?? userId,
        updatedByUserId: context?.actorUserId ?? userId,
        name: parsed.name,
        rssUrl: parsed.rssUrl,
        titlePrefix: parsed.titlePrefix ?? null,
        brandTemplateId: parsed.brandTemplateId ?? null,
        languageCode: parsed.languageCode ?? null,
        contentPack: parsed.contentPack as unknown as Prisma.InputJsonValue,
        intervalMinutes: parsed.intervalMinutes,
        maxEpisodesPerRun: parsed.maxEpisodesPerRun,
        status: "active",
        nextRunAt: new Date(),
      },
      include: { _count: { select: { episodes: true } } },
    });
    return toSnapshot(row);
  }

  async updateRule(
    userId: string,
    ruleId: string,
    input: AutopilotRuleUpdate,
    context?: { workspaceId: string; actorUserId: string },
  ): Promise<AutopilotRuleSnapshot> {
    const parsed = autopilotRuleUpdateSchema.parse(input);
    const prisma = requirePrisma();
    const existing = await prisma.autopilotRule.findFirst({
      where: { id: ruleId, ...(context ? { workspaceId: context.workspaceId } : { userId }) },
      select: { id: true },
    });
    if (!existing) {
      throw new Error("autopilot rule not found");
    }

    const row = await prisma.autopilotRule.update({
      where: { id: ruleId },
      data: {
        ...(parsed.name !== undefined && { name: parsed.name }),
        ...(parsed.rssUrl !== undefined && { rssUrl: parsed.rssUrl }),
        ...(parsed.titlePrefix !== undefined && {
          titlePrefix: parsed.titlePrefix,
        }),
        ...(parsed.brandTemplateId !== undefined && {
          brandTemplateId: parsed.brandTemplateId,
        }),
        ...(parsed.languageCode !== undefined && {
          languageCode: parsed.languageCode,
        }),
        ...(parsed.contentPack !== undefined && {
          contentPack: parsed.contentPack as unknown as Prisma.InputJsonValue,
        }),
        ...(parsed.intervalMinutes !== undefined && {
          intervalMinutes: parsed.intervalMinutes,
          nextRunAt: nextRunFrom(parsed.intervalMinutes),
        }),
        ...(parsed.maxEpisodesPerRun !== undefined && {
          maxEpisodesPerRun: parsed.maxEpisodesPerRun,
        }),
        ...(parsed.status !== undefined && {
          status: parsed.status,
          lastError: null,
          nextRunAt:
            parsed.status === "active" ? new Date() : nextRunFrom(24 * 60),
        }),
        ...(context && { updatedByUserId: context.actorUserId }),
      },
      include: { _count: { select: { episodes: true } } },
    });
    return toSnapshot(row);
  }

  async deleteRule(userId: string, ruleId: string, context?: { workspaceId: string; actorUserId: string }): Promise<void> {
    const prisma = requirePrisma();
    await prisma.autopilotRule.deleteMany({ where: { id: ruleId, ...(context ? { workspaceId: context.workspaceId } : { userId }) } });
  }

  async triggerRuleNow(userId: string, ruleId: string, context?: { workspaceId: string; actorUserId: string }): Promise<AutopilotRuleSnapshot> {
    const prisma = requirePrisma();
    const existing = await prisma.autopilotRule.findFirst({
      where: { id: ruleId, ...(context ? { workspaceId: context.workspaceId } : { userId }) },
      select: { id: true },
    });
    if (!existing) {
      throw new Error("autopilot rule not found");
    }

    const row = await prisma.autopilotRule.update({
      where: { id: ruleId },
      data: {
        status: "active",
        nextRunAt: new Date(),
        lastError: null,
        ...(context && { updatedByUserId: context.actorUserId }),
      },
      include: { _count: { select: { episodes: true } } },
    });
    return toSnapshot(row);
  }

  async processDueRules(limit = 3): Promise<{ checked: number; imported: number }> {
    const prisma = requirePrisma();
    const now = new Date();
    const due = await prisma.autopilotRule.findMany({
      where: {
        status: "active",
        nextRunAt: { lte: now },
        OR: [{ workspaceId: null }, { workspace: { status: "active" } }],
      },
      orderBy: { nextRunAt: "asc" },
      take: Math.max(1, Math.min(10, limit)),
    });

    let checked = 0;
    let imported = 0;

    for (const rule of due) {
      const claimed = await prisma.autopilotRule.updateMany({
        where: { id: rule.id, status: "active" },
        data: { status: "running", lastError: null },
      });
      if (claimed.count === 0) continue;

      checked += 1;
      try {
        const result = await this.processRule(rule.id);
        imported += result.imported;
      } catch (error) {
        await prisma.autopilotRule.update({
          where: { id: rule.id },
          data: {
            status: "failed",
            lastError: error instanceof Error ? error.message : "Autopilot failed",
            lastCheckedAt: new Date(),
            nextRunAt: nextRunFrom(rule.intervalMinutes),
          },
        });
      }
    }

    return { checked, imported };
  }

  private async processRule(ruleId: string): Promise<{ imported: number }> {
    const prisma = requirePrisma();
    const rule = await prisma.autopilotRule.findUnique({
      where: { id: ruleId },
    });
    if (!rule) {
      throw new Error("autopilot rule not found");
    }

    const [episodes, existingEpisodes] = await Promise.all([
      fetchRssEpisodes(rule.rssUrl),
      prisma.autopilotEpisode.findMany({
        where: { ruleId: rule.id },
        select: { episodeId: true },
      }),
    ]);
    const existingIds = new Set(
      existingEpisodes.map((episode) => episode.episodeId),
    );
    const unseen = episodes
      .filter((episode) => !existingIds.has(episode.id))
      .slice(0, rule.maxEpisodesPerRun);
    const contentPack = parseStoredContentPack(rule.contentPack);

    let imported = 0;
    for (const episode of unseen) {
      const result = await projectService.importFromRss(rule.userId, {
        rssUrl: rule.rssUrl,
        episodes: [episode],
        titlePrefix: rule.titlePrefix ?? undefined,
        brandTemplateId: rule.brandTemplateId ?? null,
      }, rule.workspaceId ?? undefined);
      const projectId = result.projects[0]?.project.id;
      if (!projectId) continue;

      await projectService.prepareGenerationContext(
        rule.userId,
        projectId,
        contentPack,
        rule.languageCode,
      );

      await prisma.autopilotEpisode.upsert({
        where: {
          ruleId_episodeId: {
            ruleId: rule.id,
            episodeId: episode.id,
          },
        },
        create: {
          ruleId: rule.id,
          episodeId: episode.id,
          projectId,
        },
        update: { projectId },
      });
      imported += 1;
    }

    await prisma.autopilotRule.update({
      where: { id: rule.id },
      data: {
        status: "active",
        lastCheckedAt: new Date(),
        nextRunAt: nextRunFrom(rule.intervalMinutes),
        lastError: null,
      },
    });

    return { imported };
  }
}

export const autopilotService = new AutopilotService();
