import { appendZoomRuleWake,appendZoomRuleDeletionWake } from "./zoom-rule-wakes";
import { queueAutopilotRule } from "./autopilot-execution";
export { AUTOPILOT_LEASE_MS, AUTOPILOT_MAX_CONSECUTIVE_FAILURES, autopilotRetryDelayMs, selectAutopilotEpisodes } from "./autopilot-episode-policy";
import { zoomService } from "./zoom.service";
import { readExecutionAdmission, assertExecutionAdmissionOpen, requireExecutionAdmissionOpen } from "./execution-admission";
import { ZoomError } from "./zoom";
import { workspaceService } from "./workspace.service";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import type { IntegrationMutation } from "./operation-receipt";
import type { ActorScope } from "./actor-scope";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  autopilotRuleInputSchema,
  autopilotRuleUpdateSchema,
  type AutopilotRuleInput,
  type AutopilotRuleSnapshot,
  type AutopilotPauseKind,
  type AutopilotRuleUpdate,
} from "@narriflow/validators";
import { fetchRssFeed, redactUrlForDisplay } from "./rss";
import { lockLiveRecipe, recipeService } from "./recipe.service";
import { pauseGrantsWhoseRuleChanged, revokeGrantsInTransaction } from "./standing-grant";
import { flushWorkspaceEvents } from "./workspace-event";
import { requirePlanFeature } from "./plan-features";
import { holdsAutopilotSlot, lockWorkspaceAutopilotRules, requireAutopilotRuleSlot } from "./autopilot-plan";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

export const MAX_AUTOPILOT_RULES_PER_WORKSPACE = 10;

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

async function queueRuleExecution(tx:Prisma.TransactionClient,id:string,repairOnly=false){
  await queueAutopilotRule(tx,id);
  await appendZoomRuleWake(tx,id,{repairOnly});
}

function nextRunFrom(intervalMinutes: number, now = Date.now()) {
  return new Date(now + intervalMinutes * 60 * 1000);
}

const ruleInclude = {
  _count: { select: { episodes: true } },
  recipe: { select: { name: true } },
} as const;


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

export class AutopilotService {
  constructor(private readonly dependencies: {
    fetchFeed?: typeof fetchRssFeed;
  } = {}) {}

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
    // The prepare callback runs only after an exact acceptance replay is resolved.
    const parsed = autopilotRuleInputSchema.parse(input);
    let feed: Awaited<ReturnType<typeof fetchRssFeed>> | null = null;
    const prepare = async () => {
      requirePlanFeature(actor.pricingTier,"automation.autopilot");
      if (parsed.sourceKind === "rss") feed = await (this.dependencies.fetchFeed ?? fetchRssFeed)(parsed.rssUrl!, { scope });
      else await zoomService.requireConnection(scope, parsed.zoomConnectionId!);
      // The Recipe's settings must be ones this saver could have chosen: its
      // Brand Profile applies now, and finishing fits the plan and queue rights.
      await recipeService.resolveForRule(scope, parsed.recipeId, credential);
    };

    const prisma = requirePrisma();
    const create = async (tx: Prisma.TransactionClient) => {
      const admission = await requireExecutionAdmissionOpen(tx);
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
          deploymentEpoch: admission.epoch,
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
      await queueRuleExecution(tx,row.id);
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
        beforeMutation: mutation.beforeMutation,
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
      if (accepted.replayed) await prisma.$transaction(tx=>queueAutopilotRule(tx,accepted.value.id));
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

    const feed = parsed.rssUrl ? await (this.dependencies.fetchFeed ?? fetchRssFeed)(parsed.rssUrl, { scope }) : null;
    const mode = parsed.initialImportMode ?? existing.initialImportMode;
    const now = new Date();
    const resetFeed = Boolean(feed);
    const futureOnly = mode === "future_only";
    const head = feed?.episodes[0] ?? null;
    const row = await prisma.$transaction(async (tx) => {
      const admission = await readExecutionAdmission(tx);
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
      if (resumes || parsed.rssUrl || parsed.zoomConnectionId || parsed.status === "active" || (current.status === "running" && parsed.status !== "paused")) assertExecutionAdmissionOpen(admission);
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
          generation: { increment: 1 },
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
      await queueRuleExecution(tx,updated.id);
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
      await readExecutionAdmission(tx);
      // The rule's row first, as every path that touches a rule and its grants does. The grants a
      // rule had are revoked, not deleted: they and their audit trail outlive the rule.
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AutopilotRule" WHERE "id" = ${ruleId}::uuid AND "workspaceId" = ${scope.workspaceId}::uuid FOR UPDATE`;
      if (!locked) { await appendZoomRuleDeletionWake(tx,scope.workspaceId,ruleId,true);return; }
      const source=await tx.autopilotRule.findUniqueOrThrow({where:{id:ruleId}});
      if(source.sourceKind==="zoom")await appendZoomRuleDeletionWake(tx,scope.workspaceId,ruleId);
      await revokeGrantsInTransaction(tx, { autopilotRuleId: ruleId }, "rule_deleted");
      await tx.autopilotRule.delete({ where: { id: ruleId } });
    });
    // Posts a revoked grant scheduled go back to the proposal inbox.
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
    // A new run is admitted after the exact acceptance replay is resolved.
    const prisma = requirePrisma();
    const trigger = async (tx: Prisma.TransactionClient) => {
      const admission = await readExecutionAdmission(tx);
      requirePlanFeature(actor.pricingTier,"automation.autopilot");
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
        existing.status === "running" && existing.executionCycleId
      ) {
        await queueRuleExecution(tx,existing.id);
        return toSnapshot(existing);
      }
      if (!holdsAutopilotSlot(existing.status)) {
        await requireAutopilotRuleSlot(tx, { workspaceId: scope.workspaceId, tier: actor.pricingTier, ruleId });
      }

      assertExecutionAdmissionOpen(admission);

      const row = await tx.autopilotRule.update({
        where: { id: ruleId },
        data: {
          generation: { increment: 1 },
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
      await queueRuleExecution(tx,row.id);
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
        beforeMutation: mutation.beforeMutation,
        mutate: async (tx) => {
          const value = await trigger(tx);
          return {
            resourceType: "autopilot_rule",
            resourceId: value.id,
            value,
          };
        },
      });
      if (accepted.replayed) await prisma.$transaction(tx=>queueAutopilotRule(tx,accepted.value.id));
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
      await requireExecutionAdmissionOpen(tx);
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
          generation: { increment: 1 },
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
      await queueRuleExecution(tx,row.id);
      return toSnapshot(row);
    });
  }

}

export const autopilotService = new AutopilotService();
