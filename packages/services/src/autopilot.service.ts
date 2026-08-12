import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  autopilotRuleInputSchema,
  autopilotRuleUpdateSchema,
  parseStoredContentPack,
  type AutopilotRuleInput,
  type AutopilotRuleSnapshot,
  type AutopilotRuleUpdate,
  type RssEpisodeInput,
} from "@narriflow/validators";
import { fetchRssFeed, redactUrlForDisplay, RssFeedError } from "./rss";
import { RemoteFetchError, UnsafeUrlError } from "./url-guard";
import { projectService } from "./project.service";

export const MAX_AUTOPILOT_RULES_PER_WORKSPACE = 10;
export const AUTOPILOT_LEASE_MS = 2 * 60 * 1000;
export const AUTOPILOT_MAX_CONSECUTIVE_FAILURES = 8;

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function nextRunFrom(intervalMinutes: number, now = Date.now()) {
  return new Date(now + intervalMinutes * 60 * 1000);
}

export function autopilotRetryDelayMs(
  consecutiveFailures: number,
  intervalMinutes: number,
) {
  const exponent = Math.max(0, Math.min(10, consecutiveFailures - 1));
  const retryDelay = 60_000 * 2 ** exponent;
  return Math.min(intervalMinutes * 60_000, retryDelay);
}

type EpisodeSelectionRule = {
  initializedAt: Date | null;
  initialImportMode: "future_only" | "latest";
  initialImportCount: number;
  maxEpisodesPerRun: number;
  lastSeenEpisodeId: string | null;
  lastSeenPublishedAt: Date | null;
};

export function selectAutopilotEpisodes(
  episodes: RssEpisodeInput[],
  existingIds: ReadonlySet<string>,
  rule: EpisodeSelectionRule,
): { episodes: RssEpisodeInput[]; shouldAdvanceCursor: boolean } {
  if (!rule.initializedAt) {
    if (rule.initialImportMode === "future_only") {
      return { episodes: [], shouldAdvanceCursor: true };
    }
    return {
      episodes: episodes
        .filter((episode) => !existingIds.has(episode.id))
        .slice(0, Math.min(rule.initialImportCount, rule.maxEpisodesPerRun)),
      // Initial latest-N is an explicit bounded backfill. Older entries are
      // intentionally behind the new cursor and will not churn on later runs.
      shouldAdvanceCursor: true,
    };
  }

  let newWindow: RssEpisodeInput[];
  const cursorIndex = rule.lastSeenEpisodeId
    ? episodes.findIndex((episode) => episode.id === rule.lastSeenEpisodeId)
    : -1;
  if (cursorIndex >= 0) {
    newWindow = episodes.slice(0, cursorIndex);
  } else if (rule.lastSeenPublishedAt) {
    const baseline = rule.lastSeenPublishedAt.getTime();
    newWindow = episodes.filter(
      (episode) =>
        episode.publishedAt !== null &&
        episode.publishedAt !== undefined &&
        Date.parse(episode.publishedAt) > baseline,
    );
  } else {
    // If an undated cursor disappeared from a rolling feed, importing every
    // item would be a surprise backfill. Wait for an identifiable new head.
    newWindow = [];
  }

  const unseen = newWindow.filter((episode) => !existingIds.has(episode.id));
  return {
    episodes: unseen.slice(0, rule.maxEpisodesPerRun),
    shouldAdvanceCursor: unseen.length <= rule.maxEpisodesPerRun,
  };
}

function isPermanentFeedError(error: unknown) {
  return error instanceof RssFeedError || error instanceof UnsafeUrlError;
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
  feedTitle: string | null;
  initialImportMode: "future_only" | "latest";
  initialImportCount: number;
  status: string;
  lastCheckedAt: Date | null;
  lastSuccessAt: Date | null;
  nextRunAt: Date;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: Date;
  _count?: { episodes: number };
}): AutopilotRuleSnapshot {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    rssUrl: redactUrlForDisplay(row.rssUrl),
    titlePrefix: row.titlePrefix,
    brandTemplateId: row.brandTemplateId,
    languageCode: row.languageCode,
    contentPack: parseStoredContentPack(row.contentPack),
    intervalMinutes: row.intervalMinutes,
    maxEpisodesPerRun: row.maxEpisodesPerRun,
    feedTitle: row.feedTitle,
    initialImportMode: row.initialImportMode,
    initialImportCount: row.initialImportCount,
    status: row.status as AutopilotRuleSnapshot["status"],
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt.toISOString(),
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    importedEpisodeCount: row._count?.episodes ?? 0,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AutopilotService {
  async listRules(
    userId: string,
    workspaceId?: string,
  ): Promise<AutopilotRuleSnapshot[]> {
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
    const [feed, ruleCount] = await Promise.all([
      fetchRssFeed(parsed.rssUrl),
      requirePrisma().autopilotRule.count({
        where: context?.workspaceId ? { workspaceId: context.workspaceId } : { userId },
      }),
    ]);
    if (ruleCount >= MAX_AUTOPILOT_RULES_PER_WORKSPACE) {
      throw new Error("autopilot_rule_limit_reached");
    }

    const prisma = requirePrisma();
    const now = new Date();
    const head = feed.episodes[0] ?? null;
    const futureOnly = parsed.initialImportMode === "future_only";
    const row = await prisma.autopilotRule.create({
      data: {
        userId,
        workspaceId: context?.workspaceId ?? null,
        createdByUserId: context?.actorUserId ?? userId,
        updatedByUserId: context?.actorUserId ?? userId,
        name: parsed.name,
        rssUrl: feed.finalUrl,
        feedTitle: feed.title,
        titlePrefix: parsed.titlePrefix ?? null,
        brandTemplateId: parsed.brandTemplateId ?? null,
        languageCode: parsed.languageCode ?? null,
        contentPack: parsed.contentPack as unknown as Prisma.InputJsonValue,
        intervalMinutes: parsed.intervalMinutes,
        maxEpisodesPerRun: parsed.maxEpisodesPerRun,
        initialImportMode: parsed.initialImportMode,
        initialImportCount: parsed.initialImportCount,
        initializedAt: futureOnly ? now : null,
        lastSeenEpisodeId: futureOnly ? head?.id ?? null : null,
        lastSeenPublishedAt:
          futureOnly && head?.publishedAt ? new Date(head.publishedAt) : null,
        etag: futureOnly ? feed.etag : null,
        lastModified: futureOnly ? feed.lastModified : null,
        status: "active",
        nextRunAt: futureOnly
          ? nextRunFrom(parsed.intervalMinutes, now.getTime())
          : now,
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
      where: {
        id: ruleId,
        ...(context ? { workspaceId: context.workspaceId } : { userId }),
      },
    });
    if (!existing) throw new Error("autopilot rule not found");

    const feed = parsed.rssUrl ? await fetchRssFeed(parsed.rssUrl) : null;
    const mode = parsed.initialImportMode ?? existing.initialImportMode;
    const now = new Date();
    const resetFeed = Boolean(feed);
    const futureOnly = mode === "future_only";
    const head = feed?.episodes[0] ?? null;
    const row = await prisma.autopilotRule.update({
      where: { id: ruleId },
      data: {
        ...(parsed.name !== undefined && { name: parsed.name }),
        ...(feed && {
          rssUrl: feed.finalUrl,
          feedTitle: feed.title,
          etag: feed.etag,
          lastModified: feed.lastModified,
        }),
        ...(parsed.titlePrefix !== undefined && { titlePrefix: parsed.titlePrefix }),
        ...(parsed.brandTemplateId !== undefined && {
          brandTemplateId: parsed.brandTemplateId,
        }),
        ...(parsed.languageCode !== undefined && { languageCode: parsed.languageCode }),
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
        ...(parsed.initialImportMode !== undefined && {
          initialImportMode: parsed.initialImportMode,
        }),
        ...(parsed.initialImportCount !== undefined && {
          initialImportCount: parsed.initialImportCount,
        }),
        ...(resetFeed && {
          initializedAt: futureOnly ? now : null,
          lastSeenEpisodeId: futureOnly ? head?.id ?? null : null,
          lastSeenPublishedAt:
            futureOnly && head?.publishedAt ? new Date(head.publishedAt) : null,
          nextRunAt: futureOnly
            ? nextRunFrom(parsed.intervalMinutes ?? existing.intervalMinutes)
            : now,
          consecutiveFailures: 0,
          lastError: null,
        }),
        ...(parsed.status !== undefined && {
          status: parsed.status,
          leaseExpiresAt: null,
          lastError: null,
          consecutiveFailures: 0,
          nextRunAt:
            parsed.status === "active" ? now : nextRunFrom(24 * 60),
        }),
        ...(context && { updatedByUserId: context.actorUserId }),
      },
      include: { _count: { select: { episodes: true } } },
    });
    return toSnapshot(row);
  }

  async deleteRule(
    userId: string,
    ruleId: string,
    context?: { workspaceId: string; actorUserId: string },
  ): Promise<void> {
    const prisma = requirePrisma();
    await prisma.autopilotRule.deleteMany({
      where: {
        id: ruleId,
        ...(context ? { workspaceId: context.workspaceId } : { userId }),
      },
    });
  }

  async triggerRuleNow(
    userId: string,
    ruleId: string,
    context?: { workspaceId: string; actorUserId: string },
  ): Promise<AutopilotRuleSnapshot> {
    const prisma = requirePrisma();
    const existing = await prisma.autopilotRule.findFirst({
      where: {
        id: ruleId,
        ...(context ? { workspaceId: context.workspaceId } : { userId }),
      },
      include: { _count: { select: { episodes: true } } },
    });
    if (!existing) throw new Error("autopilot rule not found");
    if (existing.status === "running" && existing.leaseExpiresAt && existing.leaseExpiresAt > new Date()) {
      return toSnapshot(existing);
    }

    const row = await prisma.autopilotRule.update({
      where: { id: ruleId },
      data: {
        status: "active",
        nextRunAt: new Date(),
        leaseExpiresAt: null,
        lastError: null,
        consecutiveFailures: 0,
        ...(context && { updatedByUserId: context.actorUserId }),
      },
      include: { _count: { select: { episodes: true } } },
    });
    return toSnapshot(row);
  }

  async reapStalledRules(now = new Date()): Promise<number> {
    const prisma = requirePrisma();
    const result = await prisma.autopilotRule.updateMany({
      where: { status: "running", leaseExpiresAt: { lte: now } },
      data: {
        status: "active",
        leaseExpiresAt: null,
        nextRunAt: now,
        lastError: "Previous Autopilot worker stopped before completing the run; retrying.",
      },
    });
    return result.count;
  }

  async processDueRules(limit = 3): Promise<{ checked: number; imported: number }> {
    const prisma = requirePrisma();
    const now = new Date();
    await this.reapStalledRules(now);
    const due = await prisma.autopilotRule.findMany({
      where: {
        status: "active",
        nextRunAt: { lte: now },
        user: { deletedAt: null },
        OR: [{ workspaceId: null }, { workspace: { status: "active" } }],
      },
      orderBy: { nextRunAt: "asc" },
      take: Math.max(1, Math.min(10, limit)),
    });

    let checked = 0;
    let imported = 0;
    for (const rule of due) {
      const claimed = await prisma.autopilotRule.updateMany({
        where: {
          id: rule.id,
          status: "active",
          nextRunAt: { lte: now },
        },
        data: {
          status: "running",
          leaseExpiresAt: new Date(Date.now() + AUTOPILOT_LEASE_MS),
          lastError: null,
        },
      });
      if (claimed.count === 0) continue;

      checked += 1;
      try {
        const result = await this.processRule(rule.id);
        imported += result.imported;
      } catch (error) {
        const failures = rule.consecutiveFailures + 1;
        const permanent = isPermanentFeedError(error);
        const terminal = permanent || failures >= AUTOPILOT_MAX_CONSECUTIVE_FAILURES;
        const retryAt = new Date(
          Date.now() + autopilotRetryDelayMs(failures, rule.intervalMinutes),
        );
        await prisma.autopilotRule.update({
          where: { id: rule.id },
          data: {
            status: terminal ? "failed" : "active",
            leaseExpiresAt: null,
            consecutiveFailures: failures,
            lastError: error instanceof Error ? error.message : "Autopilot failed",
            lastCheckedAt: new Date(),
            nextRunAt: retryAt,
          },
        });
        console.warn(
          JSON.stringify({
            level: terminal ? "error" : "warn",
            message: "autopilot_rule_failed",
            ruleId: rule.id,
            failures,
            terminal,
            retryAt: terminal ? null : retryAt.toISOString(),
            error:
              error instanceof RemoteFetchError || error instanceof Error
                ? error.message
                : "unknown",
          }),
        );
      }
    }
    return { checked, imported };
  }

  private async processRule(ruleId: string): Promise<{ imported: number }> {
    const prisma = requirePrisma();
    const rule = await prisma.autopilotRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new Error("autopilot rule not found");

    const feed = await fetchRssFeed(rule.rssUrl, {
      etag: rule.initializedAt ? rule.etag : null,
      lastModified: rule.initializedAt ? rule.lastModified : null,
    });
    const now = new Date();
    if (feed.notModified) {
      await prisma.autopilotRule.update({
        where: { id: rule.id },
        data: {
          status: "active",
          leaseExpiresAt: null,
          lastCheckedAt: now,
          lastSuccessAt: now,
          nextRunAt: nextRunFrom(rule.intervalMinutes, now.getTime()),
          lastError: null,
          consecutiveFailures: 0,
        },
      });
      return { imported: 0 };
    }

    const currentEpisodeIds = feed.episodes.map((episode) => episode.id);
    const existingEpisodes = currentEpisodeIds.length
      ? await prisma.autopilotEpisode.findMany({
          where: { ruleId: rule.id, episodeId: { in: currentEpisodeIds } },
          select: { episodeId: true },
        })
      : [];
    const existingIds = new Set(existingEpisodes.map((episode) => episode.episodeId));
    const selection = selectAutopilotEpisodes(feed.episodes, existingIds, rule);
    const contentPack = parseStoredContentPack(rule.contentPack);

    let imported = 0;
    for (const episode of selection.episodes) {
      const result = await projectService.importResolvedRssEpisodes(
        rule.userId,
        {
          rssUrl: feed.finalUrl,
          episodes: [episode],
          titlePrefix: rule.titlePrefix ?? undefined,
          brandTemplateId: rule.brandTemplateId ?? null,
        },
        rule.workspaceId ?? undefined,
        {
          generationContext: { contentPack, languageCode: rule.languageCode },
          autopilotRuleId: rule.id,
        },
      );
      imported += result.count;
    }

    const head = feed.episodes[0] ?? null;
    const initialize = !rule.initializedAt || selection.shouldAdvanceCursor;
    await prisma.autopilotRule.update({
      where: { id: rule.id },
      data: {
        status: "active",
        leaseExpiresAt: null,
        initializedAt: rule.initializedAt ?? now,
        ...(initialize && {
          lastSeenEpisodeId: head?.id ?? rule.lastSeenEpisodeId,
          lastSeenPublishedAt: head?.publishedAt
            ? new Date(head.publishedAt)
            : rule.lastSeenPublishedAt,
        }),
        // A backlog larger than maxEpisodesPerRun must force another full
        // response. Saving the new validators early would yield 304 and strand
        // the remaining unseen episodes behind the old cursor.
        etag: selection.shouldAdvanceCursor ? feed.etag : null,
        lastModified: selection.shouldAdvanceCursor ? feed.lastModified : null,
        feedTitle: feed.title,
        lastCheckedAt: now,
        lastSuccessAt: now,
        nextRunAt: nextRunFrom(rule.intervalMinutes, now.getTime()),
        lastError: null,
        consecutiveFailures: 0,
      },
    });
    return { imported };
  }
}

export const autopilotService = new AutopilotService();
