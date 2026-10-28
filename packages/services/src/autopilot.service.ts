import { zoomService } from "./zoom.service";
import { ZoomError } from "./zoom";
import { workspaceService, WorkspaceOperationError } from "./workspace.service";
import { BrandProfileMembershipError, BrandProfileMissingAssetError, BrandProfileNotFoundError } from "./brand-profile.service";
import { isBrandAccessRefusal } from "./brand-ownership";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import type { IntegrationMutation } from "./operation-receipt";
import type { ActorScope } from "./actor-scope";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  acceptedRecipe,
  autopilotRuleInputSchema,
  autopilotRuleUpdateSchema,
  type AutopilotRuleInput,
  type AutopilotRuleSnapshot,
  type AutopilotPauseKind,
  type AutopilotRuleUpdate,
  type RssEpisodeInput,
} from "@narriflow/validators";
import { fetchRssFeed, redactUrlForDisplay, RssFeedError } from "./rss";
import { RemoteFetchError, UnsafeUrlError } from "./url-guard";
import { ProcessingUsageError } from "./processing-usage";
import { projectService } from "./project.service";
import { lockLiveRecipe, recipeService, type ResolvedRecipe } from "./recipe.service";
import { pauseGrantsWhoseRuleChanged, returnGrantPosts, revokeGrantsInTransaction } from "./standing-grant";
import { flushWorkspaceEvents } from "./workspace-event";
import { requirePlanFeature } from "./plan-features";
import { autopilotPlanPauseReason, holdsAutopilotSlot, lockWorkspaceAutopilotRules, requireAutopilotRuleSlot } from "./autopilot-plan";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

export const MAX_AUTOPILOT_RULES_PER_WORKSPACE = 10;
export const AUTOPILOT_LEASE_MS = 2 * 60 * 1000;
export const AUTOPILOT_MAX_CONSECUTIVE_FAILURES = 8;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const autopilotFailureCatalog = {
  autopilot_rule_limit_reached: "conflict",
  autopilot_rule_not_found: "missing",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type AutopilotFailureCode = keyof typeof autopilotFailureCatalog;

export class AutopilotError extends ExpectedDomainFailureError<AutopilotFailureCode> {
  constructor(code: AutopilotFailureCode) {
    super({
      code,
      kind: autopilotFailureCatalog[code],
      message:
        code === "autopilot_rule_not_found"
          ? "Autopilot rule not found"
          : "This workspace has reached its Autopilot rule limit",
    });
    this.name = "AutopilotError";
  }
}

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

/** The ways applying a Brand Profile can be refused: deleted, missing logo
 * file or plan. */
function isBrandProfileRefusal(error: unknown) {
  return (
    error instanceof BrandProfileNotFoundError ||
    error instanceof BrandProfileMissingAssetError ||
    error instanceof BrandProfileMembershipError ||
    isBrandAccessRefusal(error)
  );
}

const ruleInclude = {
  _count: { select: { episodes: true } },
  recipe: { select: { name: true } },
} as const;

function isPermanentFeedError(error: unknown) {
  return error instanceof RssFeedError || error instanceof UnsafeUrlError;
}

function toSnapshot(row: {
  id: string;
  workspaceId: string;
  createdByUserId: string | null;
  name: string;
  rssUrl: string | null;
  sourceKind: "rss" | "zoom";
  zoomConnectionId: string | null;
  zoomTopicFilter: string | null;
  titlePrefix: string | null;
  recipeId: string;
  recipe: { name: string };
  intervalMinutes: number;
  maxEpisodesPerRun: number;
  feedTitle: string | null;
  initialImportMode: "future_only" | "latest";
  initialImportCount: number;
  status: string;
  pauseKind: AutopilotPauseKind | null;
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
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    name: row.name,
    rssUrl: row.rssUrl ? redactUrlForDisplay(row.rssUrl) : null,
    sourceKind: row.sourceKind,
    zoomConnectionId: row.zoomConnectionId,
    zoomTopicFilter: row.zoomTopicFilter,
    titlePrefix: row.titlePrefix,
    recipeId: row.recipeId,
    recipeName: row.recipe.name,
    intervalMinutes: row.intervalMinutes,
    maxEpisodesPerRun: row.maxEpisodesPerRun,
    feedTitle: row.feedTitle,
    initialImportMode: row.initialImportMode,
    initialImportCount: row.initialImportCount,
    status: row.status as AutopilotRuleSnapshot["status"],
    pauseKind: row.pauseKind,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt.toISOString(),
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    importedEpisodeCount: row._count?.episodes ?? 0,
    createdAt: row.createdAt.toISOString(),
  };
}

class AutopilotClaimLost extends Error {
  constructor(readonly ruleId: string, readonly phase: string) {
    super("Autopilot rule ownership was lost");
    this.name = "AutopilotClaimLost";
  }
}

type AutopilotClaim = Readonly<{ ruleId: string; token: string }>;

export class AutopilotService {
  constructor(private readonly dependencies: {
    fetchFeed?: typeof fetchRssFeed;
    now?: () => Date;
  } = {}) {}

  private now() { return this.dependencies.now?.() ?? new Date(); }

  async listRules(
    scope: ActorScope,
  ): Promise<AutopilotRuleSnapshot[]> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const prisma = requirePrisma();
    const rows = await prisma.autopilotRule.findMany({
      where: { workspaceId: scope.workspaceId },
      include: ruleInclude,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toSnapshot);
  }

  async createRule(
    scope: ActorScope,
    input: AutopilotRuleInput,
    mutation?: IntegrationMutation,
    /** The calling API key or connection, when there is one (the browser has none). */
    credential?: { scopes: readonly string[] },
  ): Promise<AutopilotRuleSnapshot> {
    if (mutation) return (await this.acceptRule(scope, input, mutation, credential)).rule;
    return (await this.createRuleOnce(scope, input, undefined, credential)).rule;
  }

  /** Creates a rule once per caller key; `replayed` is true when the key had already been accepted. */
  async acceptRule(
    scope: ActorScope,
    input: AutopilotRuleInput,
    mutation: IntegrationMutation,
    credential?: { scopes: readonly string[] },
  ): Promise<{ rule: AutopilotRuleSnapshot; replayed: boolean }> {
    return this.createRuleOnce(scope, input, mutation, credential);
  }

  private async createRuleOnce(
    scope: ActorScope,
    input: AutopilotRuleInput,
    mutation: IntegrationMutation | undefined,
    credential?: { scopes: readonly string[] },
  ): Promise<{ rule: AutopilotRuleSnapshot; replayed: boolean }> {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    // Refused before the feed is fetched; the slot count is checked again with the write.
    requirePlanFeature(actor.pricingTier, "automation.autopilot");
    const parsed = autopilotRuleInputSchema.parse(input);
    let feed: Awaited<ReturnType<typeof fetchRssFeed>> | null = null;
    const prepare = async () => {
      if (parsed.sourceKind === "rss") feed = await (this.dependencies.fetchFeed ?? fetchRssFeed)(parsed.rssUrl!);
      else await zoomService.requireConnection(scope, parsed.zoomConnectionId!);
      // The Recipe's settings must be ones this saver could have chosen: its
      // Brand Profile applies now, and finishing fits the plan and queue rights.
      await recipeService.resolveForRule(scope, parsed.recipeId, credential);
    };

    const prisma = requirePrisma();
    const create = async (tx: Prisma.TransactionClient) => {
      // Serialize the workspace rule budget with its write, including distinct keys.
      await lockWorkspaceAutopilotRules(tx, scope.workspaceId);
      await requireAutopilotRuleSlot(tx, { workspaceId: scope.workspaceId, tier: actor.pricingTier });
      if (
        (await tx.autopilotRule.count({
          where: { workspaceId: scope.workspaceId },
        })) >= MAX_AUTOPILOT_RULES_PER_WORKSPACE
      )
        throw new AutopilotError("autopilot_rule_limit_reached");
      if (parsed.zoomConnectionId) {
        await tx.$queryRaw`SELECT "id" FROM "ZoomConnection" WHERE "id" = ${parsed.zoomConnectionId}::uuid FOR UPDATE`;
        if (!await tx.zoomConnection.findFirst({ where: { id: parsed.zoomConnectionId, workspaceId: scope.workspaceId, revokedAt: null } })) throw new ZoomError("zoom_connection_unavailable");
      }
      await lockLiveRecipe(tx, scope.workspaceId, parsed.recipeId);
      const now = new Date();
      const head = feed?.episodes[0] ?? null;
      const futureOnly = parsed.initialImportMode === "future_only";
      const row = await tx.autopilotRule.create({
        data: {
          workspaceId: scope.workspaceId,
          createdByUserId: scope.actorUserId,
          updatedByUserId: scope.actorUserId,
          name: parsed.name,
          sourceKind: parsed.sourceKind,
          rssUrl: feed?.finalUrl ?? null,
          zoomConnectionId: parsed.zoomConnectionId ?? null,
          zoomTopicFilter: parsed.zoomTopicFilter ?? null,
          feedTitle: feed?.title ?? null,
          titlePrefix: parsed.titlePrefix ?? null,
          recipeId: parsed.recipeId,
          intervalMinutes: parsed.intervalMinutes,
          maxEpisodesPerRun: parsed.maxEpisodesPerRun,
          initialImportMode: parsed.initialImportMode,
          initialImportCount: parsed.initialImportCount,
          initializedAt: futureOnly ? now : null,
          lastSeenEpisodeId: futureOnly ? (head?.id ?? null) : null,
          lastSeenPublishedAt: futureOnly && head?.publishedAt ? new Date(head.publishedAt) : null,
          etag: futureOnly ? feed?.etag ?? null : null,
          lastModified: futureOnly ? feed?.lastModified ?? null : null,
          status: "active",
          nextRunAt: futureOnly ? nextRunFrom(parsed.intervalMinutes, now.getTime()) : now,
        },
        include: ruleInclude,
      });
      return toSnapshot(row);
    };
    if (mutation) {
      const accepted = await getOperationReceiptExecutor().execute({
        identity: {
          workspaceId: scope.workspaceId,
          actorUserId: scope.actorUserId,
          command: "create_rss_autopilot_rule",
          clientIdempotencyKey: mutation.clientIdempotencyKey,
        },
        input: parsed,
        authorize: async () => {
          await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
        },
        beforeAccept: mutation.beforeAccept,
        prepare,
        mutate: async (tx) => {
          const value = await create(tx);
          return {
            resourceType: "autopilot_rule",
            resourceId: value.id,
            value,
          };
        },
      });
      return { rule: accepted.value, replayed: accepted.replayed };
    }
    await prepare();
    return { rule: await prisma.$transaction(create), replayed: false };
  }

  async updateRule(
    scope: ActorScope,
    ruleId: string,
    input: AutopilotRuleUpdate,
    credential?: { scopes: readonly string[] },
  ): Promise<AutopilotRuleSnapshot> {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    const parsed = autopilotRuleUpdateSchema.parse(input);
    // A new source is new automation; renaming or pausing a rule needs no plan.
    if (parsed.rssUrl || parsed.zoomConnectionId) requirePlanFeature(actor.pricingTier, "automation.autopilot");
    const prisma = requirePrisma();
    const existing = await prisma.autopilotRule.findFirst({
      where: {
        id: ruleId,
        workspaceId: scope.workspaceId,
      },
    });
    if (!existing) throw new AutopilotError("autopilot_rule_not_found");
    if (existing.sourceKind === "rss" && (parsed.zoomConnectionId !== undefined || parsed.zoomTopicFilter !== undefined || parsed.rssUrl === null)) throw new ZoomError("zoom_payload_invalid");
    if (existing.sourceKind === "zoom") {
      if (parsed.rssUrl !== undefined || (parsed.initialImportMode !== undefined && parsed.initialImportMode !== "future_only") || parsed.zoomConnectionId === null) throw new ZoomError("zoom_payload_invalid");
      if (parsed.zoomConnectionId !== undefined || parsed.status === "active") await zoomService.requireConnection(scope, parsed.zoomConnectionId ?? existing.zoomConnectionId!);
    }

    // Pointing a rule at a Recipe is a save of that Recipe's settings for it.
    if (parsed.recipeId !== undefined) await recipeService.resolveForRule(scope, parsed.recipeId, credential);

    const feed = parsed.rssUrl ? await (this.dependencies.fetchFeed ?? fetchRssFeed)(parsed.rssUrl) : null;
    const mode = parsed.initialImportMode ?? existing.initialImportMode;
    const now = new Date();
    const resetFeed = Boolean(feed);
    const futureOnly = mode === "future_only";
    const head = feed?.episodes[0] ?? null;
    const row = await prisma.$transaction(async (tx) => {
      // The Workspace's rules first, so a resume counts active rules with its write.
      await lockWorkspaceAutopilotRules(tx, scope.workspaceId);
      if (parsed.recipeId !== undefined) await lockLiveRecipe(tx, scope.workspaceId, parsed.recipeId);
      // Revoke against the current row: a worker may claim after the initial read.
      const current = await tx.autopilotRule.update({
        where: { id: ruleId },
        data: { claimToken: null, leaseExpiresAt: null },
        select: { status: true, pauseKind: true, zoomConnectionId: true },
      });
      const resumes = !holdsAutopilotSlot(current.status) && (parsed.status === "active" ||
        (current.status === "paused" && current.pauseKind === "brand_profile" && parsed.recipeId !== undefined));
      if (resumes) await requireAutopilotRuleSlot(tx, { workspaceId: scope.workspaceId, tier: actor.pricingTier, ruleId });
      if (existing.sourceKind === "zoom" && (parsed.zoomConnectionId !== undefined || parsed.status === "active")) {
        const connectionId = parsed.zoomConnectionId ?? current.zoomConnectionId;
        if (!connectionId) throw new ZoomError("zoom_connection_unavailable");
        await tx.$queryRaw`SELECT "id" FROM "ZoomConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`;
        if (!await tx.zoomConnection.findFirst({ where: { id: connectionId, workspaceId: scope.workspaceId, revokedAt: null } })) throw new ZoomError("zoom_connection_unavailable");
      }
      // Autopilot paused this rule itself; choosing a Brand Profile resumes it.
      // If the acting member is still unavailable, the next run pauses it again.
      const systemPaused = current.status === "paused" && current.pauseKind !== null;
      const updated = await tx.autopilotRule.update({
        where: { id: ruleId },
        data: {
          ...(current.status === "running" && { status: "active", nextRunAt: now }),
          ...(parsed.name !== undefined && { name: parsed.name }),
          ...(parsed.zoomConnectionId !== undefined && { zoomConnectionId: parsed.zoomConnectionId }),
          ...(parsed.zoomTopicFilter !== undefined && { zoomTopicFilter: parsed.zoomTopicFilter }),
          ...(feed && {
            rssUrl: feed.finalUrl,
            feedTitle: feed.title,
            etag: feed.etag,
            lastModified: feed.lastModified,
          }),
          ...(parsed.titlePrefix !== undefined && { titlePrefix: parsed.titlePrefix }),
          ...(parsed.recipeId !== undefined && { recipeId: parsed.recipeId }),
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
            ...(!systemPaused && { lastError: null }),
          }),
          ...(systemPaused && current.pauseKind === "brand_profile" && parsed.recipeId !== undefined && {
            status: "active",
            nextRunAt: now,
            lastError: null,
            pauseKind: null,
          }),
          ...(parsed.status !== undefined && {
            status: parsed.status,
            lastError: null,
            pauseKind: null,
            consecutiveFailures: 0,
            nextRunAt:
              parsed.status === "active" ? now : nextRunFrom(24 * 60),
          }),
          updatedByUserId: scope.actorUserId,
        },
        include: ruleInclude,
      });
      // A grant is for the rule as its granter saw it: an edit that changes what the rule reads,
      // applies or does pauses its grants until a person renews them.
      await pauseGrantsWhoseRuleChanged(tx, ruleId);
      await flushWorkspaceEvents(tx);
      return updated;
    });
    return toSnapshot(row);
  }

  async deleteRule(
    scope: ActorScope,
    ruleId: string,
  ): Promise<void> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    const prisma = requirePrisma();
    await prisma.$transaction(async (tx) => {
      // The rule's row first, as every path that touches a rule and its grants does. The grants a
      // rule had are revoked, not deleted: they and their audit trail outlive the rule.
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AutopilotRule" WHERE "id" = ${ruleId}::uuid AND "workspaceId" = ${scope.workspaceId}::uuid FOR UPDATE`;
      if (!locked) return;
      await revokeGrantsInTransaction(tx, { autopilotRuleId: ruleId }, "rule_deleted");
      await tx.autopilotRule.delete({ where: { id: ruleId } });
    });
    // Posts a revoked grant scheduled go back to the proposal inbox.
    await returnGrantPosts(prisma);
  }

  async triggerRuleNow(
    scope: ActorScope,
    ruleId: string,
    mutation?: IntegrationMutation,
  ): Promise<AutopilotRuleSnapshot> {
    return (await this.triggerRuleOnce(scope, ruleId, mutation)).rule;
  }

  /** Runs a rule now once per caller key; `replayed` is true when the key had already been accepted. */
  async acceptRunNow(
    scope: ActorScope,
    ruleId: string,
    mutation: IntegrationMutation,
  ): Promise<{ rule: AutopilotRuleSnapshot; replayed: boolean }> {
    return this.triggerRuleOnce(scope, ruleId, mutation);
  }

  private async triggerRuleOnce(
    scope: ActorScope,
    ruleId: string,
    mutation: IntegrationMutation | undefined,
  ): Promise<{ rule: AutopilotRuleSnapshot; replayed: boolean }> {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "processing.consume");
    // Running a rule now is new automation, and turns a paused rule back on.
    requirePlanFeature(actor.pricingTier, "automation.autopilot");
    const prisma = requirePrisma();
    const trigger = async (tx: Prisma.TransactionClient) => {
      await lockWorkspaceAutopilotRules(tx, scope.workspaceId);
      // A worker claim must remain visible before deciding to reset the rule.
      await tx.$queryRaw`SELECT "id" FROM "AutopilotRule" WHERE "id" = ${ruleId}::uuid FOR UPDATE`;
      const existing = await tx.autopilotRule.findFirst({
        where: {
          id: ruleId,
          workspaceId: scope.workspaceId,
        },
        include: ruleInclude,
      });
      if (!existing) throw new AutopilotError("autopilot_rule_not_found");
      if (existing.sourceKind === "zoom") await zoomService.requireConnection(scope, existing.zoomConnectionId!);
      if (
        existing.status === "running" &&
        existing.leaseExpiresAt &&
        existing.leaseExpiresAt > new Date()
      ) {
        return toSnapshot(existing);
      }
      if (!holdsAutopilotSlot(existing.status)) {
        await requireAutopilotRuleSlot(tx, { workspaceId: scope.workspaceId, tier: actor.pricingTier, ruleId });
      }

      const row = await tx.autopilotRule.update({
        where: { id: ruleId },
        data: {
          status: "active",
          nextRunAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
          lastError: null,
          pauseKind: null,
          consecutiveFailures: 0,
          updatedByUserId: scope.actorUserId,
        },
        include: ruleInclude,
      });
      return toSnapshot(row);
    };
    if (mutation) {
      const accepted = await getOperationReceiptExecutor().execute({
        identity: {
          workspaceId: scope.workspaceId,
          actorUserId: scope.actorUserId,
          command: "run_autopilot_rule_now",
          clientIdempotencyKey: mutation.clientIdempotencyKey,
        },
        input: { ruleId },
        authorize: async () => {
          await workspaceService.requireActor(
            scope.actorUserId,
            scope.workspaceId,
            "processing.consume",
          );
        },
        beforeAccept: mutation.beforeAccept,
        mutate: async (tx) => {
          const value = await trigger(tx);
          return {
            resourceType: "autopilot_rule",
            resourceId: value.id,
            value,
          };
        },
      });
      return { rule: accepted.value, replayed: accepted.replayed };
    }
    return { rule: await prisma.$transaction(trigger), replayed: false };
  }

  /** A Workspace Owner or Admin becomes the rule's acting member and resumes
   * it, clearing any pause reason. */
  async takeOver(scope: ActorScope, ruleId: string): Promise<AutopilotRuleSnapshot> {
    // Only Owners and Admins hold workspace.manage; both can process media.
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "workspace.manage");
    if (!UUID_PATTERN.test(ruleId)) throw new AutopilotError("autopilot_rule_not_found");
    requirePlanFeature(actor.pricingTier, "automation.autopilot");
    return requirePrisma().$transaction(async (tx) => {
      await lockWorkspaceAutopilotRules(tx, scope.workspaceId);
      await tx.$queryRaw`SELECT "id" FROM "AutopilotRule" WHERE "id" = ${ruleId}::uuid FOR UPDATE`;
      const existing = await tx.autopilotRule.findFirst({
        where: { id: ruleId, workspaceId: scope.workspaceId },
        select: { id: true, sourceKind: true, zoomConnectionId: true, status: true },
      });
      if (!existing) throw new AutopilotError("autopilot_rule_not_found");
      if (!holdsAutopilotSlot(existing.status)) {
        await requireAutopilotRuleSlot(tx, { workspaceId: scope.workspaceId, tier: actor.pricingTier, ruleId });
      }
      if (existing.sourceKind === "zoom") await zoomService.requireConnection(scope, existing.zoomConnectionId!);
      // Revoke any live claim as updateRule does: a run that already judged
      // the previous member unavailable must not pause the rule on the new one.
      const row = await tx.autopilotRule.update({
        where: { id: ruleId },
        data: {
          createdByUserId: scope.actorUserId,
          updatedByUserId: scope.actorUserId,
          status: "active",
          nextRunAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
          lastError: null,
          pauseKind: null,
          consecutiveFailures: 0,
        },
        include: ruleInclude,
      });
      return toSnapshot(row);
    });
  }

  async reapStalledRules(now = new Date()): Promise<number> {
    const prisma = requirePrisma();
    const result = await prisma.autopilotRule.updateMany({
      where: { status: "running", leaseExpiresAt: { lte: now } },
      data: {
        status: "active",
        claimToken: null,
        leaseExpiresAt: null,
        nextRunAt: now,
        lastError: "Previous Autopilot worker stopped before completing the run; retrying.",
      },
    });
    return result.count;
  }

  async processDueRules(limit = 3): Promise<{ checked: number; imported: number; claimLost: number }> {
    const prisma = requirePrisma();
    const now = this.now();
    await this.reapStalledRules(now);
    const due = await prisma.autopilotRule.findMany({
      where: {
        status: "active",
        sourceKind: "rss",
        nextRunAt: { lte: now },
        workspace: { status: "active" },
      },
      orderBy: { nextRunAt: "asc" },
      take: Math.max(1, Math.min(10, limit)),
    });

    let checked = 0;
    let imported = 0;
    let claimLost = 0;
    for (const rule of due) {
      const claim = Object.freeze({ ruleId: rule.id, token: randomUUID() });
      const claimed = await prisma.autopilotRule.updateMany({
        where: {
          id: rule.id,
          status: "active",
          nextRunAt: { lte: now },
        },
        data: {
          status: "running",
          claimToken: claim.token,
          leaseExpiresAt: new Date(this.now().getTime() + AUTOPILOT_LEASE_MS),
          lastError: null,
        },
      });
      if (claimed.count === 0) continue;

      checked += 1;
      try {
        const result = await this.processRule(claim);
        imported += result.imported;
      } catch (error) {
        if (error instanceof AutopilotClaimLost) {
          this.reportClaimLost(error);
          claimLost += 1;
          continue;
        }
        const failures = rule.consecutiveFailures + 1;
        const permanent = isPermanentFeedError(error);
        const terminal = permanent || failures >= AUTOPILOT_MAX_CONSECUTIVE_FAILURES;
        const retryAt = new Date(
          this.now().getTime() + autopilotRetryDelayMs(failures, rule.intervalMinutes),
        );
        try {
          await this.updateClaim(claim, "failure", {
            status: terminal ? "failed" : "active",
            claimToken: null,
            leaseExpiresAt: null,
            consecutiveFailures: failures,
            lastError: error instanceof Error ? error.message : "Autopilot failed",
            lastCheckedAt: this.now(),
            nextRunAt: retryAt,
          });
        } catch (settlementError) {
          if (!(settlementError instanceof AutopilotClaimLost)) throw settlementError;
          this.reportClaimLost(settlementError);
          claimLost += 1;
          continue;
        }
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
    return { checked, imported, claimLost };
  }

  private claimWhere(claim: AutopilotClaim) {
    return { id: claim.ruleId, status: "running" as const, claimToken: claim.token, leaseExpiresAt: { gt: this.now() } };
  }

  private async updateClaim(claim: AutopilotClaim, phase: string, data: Prisma.AutopilotRuleUpdateManyMutationInput) {
    const updated = await requirePrisma().autopilotRule.updateMany({ where: this.claimWhere(claim), data });
    if (updated.count !== 1) throw new AutopilotClaimLost(claim.ruleId, phase);
  }

  private renewClaim(claim: AutopilotClaim) {
    return this.updateClaim(claim, "renewal", { leaseExpiresAt: new Date(this.now().getTime() + AUTOPILOT_LEASE_MS) });
  }

  private reportClaimLost(error: AutopilotClaimLost) {
    console.warn(JSON.stringify({ level: "warn", message: "autopilot_claim_lost", ruleId: error.ruleId, phase: error.phase }));
  }

  /** The rule's acting member, or null once they can no longer act for it. */
  private async actingScope(rule: { createdByUserId: string | null; workspaceId: string }): Promise<ActorScope | null> {
    if (!rule.createdByUserId) return null;
    try {
      await workspaceService.requireActor(rule.createdByUserId, rule.workspaceId, "processing.consume");
    } catch (error) {
      if (error instanceof WorkspaceOperationError && error.code === "workspace_access_denied") return null;
      throw error;
    }
    return { actorUserId: rule.createdByUserId, workspaceId: rule.workspaceId };
  }

  private async actingMemberLostReason(rule: { createdByUserId: string | null }) {
    const user = rule.createdByUserId
      ? await requirePrisma().user.findUnique({
          where: { id: rule.createdByUserId },
          select: { firstName: true, lastName: true },
        })
      : null;
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "Its creator";
    return `${name} can no longer run this rule (account deleted, removed from the Workspace, or not allowed to process videos). A Workspace Owner or Admin can take it over to resume it.`;
  }

  private async brandProfileRefusedReason(profileId: string, error: unknown) {
    const profile = await requirePrisma().brandProfile.findUnique({
      where: { id: profileId },
      select: { name: true },
    });
    const why = error instanceof Error ? error.message : "unknown reason";
    return `Brand Profile "${profile?.name ?? "removed profile"}" could not be applied: ${why}. Fix it in Brand Kit or in the rule's Recipe, then turn the rule back on. Moving the rule to another Recipe also resumes it.`;
  }

  /** Stops the rule until someone acts. A pause is not a failure: it leaves
   * consecutiveFailures and the feed cursor alone. */
  private async pauseClaim(claim: AutopilotClaim, kind: AutopilotPauseKind, reason: string) {
    await this.updateClaim(claim, kind, {
      status: "paused",
      pauseKind: kind,
      claimToken: null,
      leaseExpiresAt: null,
      lastCheckedAt: this.now(),
      lastError: reason,
    });
    console.warn(JSON.stringify({ level: "warn", message: "autopilot_rule_paused", ruleId: claim.ruleId, kind, reason }));
  }

  private async processRule(claim: AutopilotClaim): Promise<{ imported: number }> {
    const prisma = requirePrisma();
    const rule = await prisma.autopilotRule.findFirst({ where: this.claimWhere(claim), include: { recipe: true } });
    if (!rule) throw new AutopilotClaimLost(claim.ruleId, "read");

    // Before any fetch or import: a rule the plan no longer runs pauses once, and spends nothing.
    const planReason = await autopilotPlanPauseReason(prisma, rule);
    if (planReason) {
      await this.pauseClaim(claim, "plan", planReason);
      return { imported: 0 };
    }
    const scope = await this.actingScope(rule);
    if (!scope) {
      await this.pauseClaim(claim, "acting_member", await this.actingMemberLostReason(rule));
      return { imported: 0 };
    }
    const feed = await (this.dependencies.fetchFeed ?? fetchRssFeed)(rule.rssUrl!, {
      etag: rule.initializedAt ? rule.etag : null,
      lastModified: rule.initializedAt ? rule.lastModified : null,
    });
    const now = this.now();
    if (feed.notModified) {
      await this.updateClaim(claim, "not_modified", {
        status: "active",
        claimToken: null,
        leaseExpiresAt: null,
        lastCheckedAt: now,
        lastSuccessAt: now,
        nextRunAt: nextRunFrom(rule.intervalMinutes, now.getTime()),
        lastError: null,
        consecutiveFailures: 0,
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
    // The Recipe is read now, so an edit shapes the next import and never one
    // already accepted: every Project froze its own settings when it was created.
    const recipe: ResolvedRecipe = await recipeService.resolve(scope, rule.recipeId);

    let imported = 0;
    // Episodes refused for minutes or capacity stay ahead of the cursor so the
    // next poll retries them.
    let deferred = false;
    let brandRefusal: unknown = null;
    for (const episode of selection.episodes) {
      await this.renewClaim(claim);
      try {
        const result = await projectService.importResolvedRssEpisodes(
          scope,
          {
            rssUrl: feed.finalUrl,
            episodes: [episode],
            titlePrefix: rule.titlePrefix ?? undefined,
            brandProfileId: recipe.brandProfileId,
          },
          {
            // The Recipe and revision are kept with the Project's settings for audit.
            generationContext: { contentPack: recipe.contentPack, languageCode: recipe.languageCode, finishing: recipe.finishing, recipe: acceptedRecipe(recipe) },
            autopilotRuleId: rule.id,
          },
        );
        imported += result.count;
      } catch (error) {
        if (recipe.brandProfileId && isBrandProfileRefusal(error)) {
          brandRefusal = error;
          break;
        }
        if (!(error instanceof ProcessingUsageError)) throw error;
        // Over the per-video limit can't succeed on a later poll; move on.
        if (error.code === "upload_too_long") continue;
        deferred = true;
        break;
      }
    }

    if (brandRefusal) {
      // The cursor stays put, so every refused episode imports after the fix.
      await this.pauseClaim(claim, "brand_profile", await this.brandProfileRefusedReason(recipe.brandProfileId!, brandRefusal));
      return { imported };
    }

    const head = feed.episodes[0] ?? null;
    const initialize =
      !deferred && (!rule.initializedAt || selection.shouldAdvanceCursor);
    await this.updateClaim(claim, "success", {
      status: "active",
      claimToken: null,
      leaseExpiresAt: null,
      initializedAt: rule.initializedAt ?? (deferred ? null : now),
      ...(initialize && {
        lastSeenEpisodeId: head?.id ?? rule.lastSeenEpisodeId,
        lastSeenPublishedAt: head?.publishedAt
          ? new Date(head.publishedAt)
          : rule.lastSeenPublishedAt,
      }),
      // A backlog larger than maxEpisodesPerRun, or a deferred episode, must
      // force another full response. Saving the new validators early would
      // yield 304 and strand those episodes behind the old cursor.
      etag: selection.shouldAdvanceCursor && !deferred ? feed.etag : null,
      lastModified:
        selection.shouldAdvanceCursor && !deferred ? feed.lastModified : null,
      feedTitle: feed.title,
      lastCheckedAt: now,
      lastSuccessAt: now,
      nextRunAt: nextRunFrom(rule.intervalMinutes, now.getTime()),
      lastError: null,
      consecutiveFailures: 0,
    });
    return { imported };
  }
}

export const autopilotService = new AutopilotService();
