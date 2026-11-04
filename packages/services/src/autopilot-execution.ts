import { queueOutboundProbeExecution } from "./outbound-probe-dispatch";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type AutopilotRule } from "@prisma/client";
import { roleHasWorkspaceCapability, workspaceAllowsCapability, type AutopilotPauseKind, type RssEpisodeInput } from "@narriflow/validators";
import { rssFeedSnapshotSchema, type RssFeedSnapshot } from "@narriflow/validators/outbound-probe";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { readExecutionAdmission, assertExecutionAdmissionOpen } from "./execution-admission";
import { ExecutionDispatchError, ExecutionDispatchPendingError, appendExecutionDispatch, executionDispatchIdentity, readExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { lockWorkspaceUsage } from "./processing-usage";
import { lockAutopilotImportPlan } from "./autopilot-finishing-authority";
import { autopilotPlanPauseReason } from "./autopilot-plan";
import type { OutboundProbeService } from "./outbound-probe";
import type { ActorScope } from "./actor-scope";
import { operationFingerprint } from "./operation-receipt";
import { autopilotCycleInputSchema, autopilotCycleSelectionSchema, type AutopilotCycleInput } from "@narriflow/validators/autopilot-execution";
import { AUTOPILOT_LEASE_MS, AUTOPILOT_MAX_CONSECUTIVE_FAILURES, autopilotRetryDelayMs, selectAutopilotEpisodes } from "./autopilot-episode-policy";
import { databaseNow } from "./execution-clock";

type Tx = Prisma.TransactionClient;
export const AUTOPILOT_CYCLE_DEADLINE_MS = 3600_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function autopilotExecutionInputHash(rule: AutopilotRule) {
  return hash(["autopilot-rule-v1", rule.id, rule.deploymentEpoch, rule.generation, rule.executionCycleId, rule.executionInputHash, rule.executionCursor, rule.nextRunAt.toISOString(), rule.executionDueAt?.toISOString(), rule.operationDeadlineAt?.toISOString()]);
}
async function appendRule(tx: Tx, rule: AutopilotRule, options: { wakeKind?: string; dueAt?: Date; deadline?: { kind: "operation" | "lease"; at: Date } } = {}) {
  const identity = { deploymentEpoch: rule.deploymentEpoch, generation: rule.generation, kind: "operation_driver" as const, subject: { kind: "autopilot_rule" as const, id: rule.id },
    ...(options.wakeKind ? { wakeKind: options.wakeKind } : {}), ...(options.deadline ? { deadlineKind: options.deadline.kind, observedDeadlineAt: options.deadline.at } : {}) };
  const key = await executionDispatchIdentity(identity), existing = await tx.executionDispatch.findUnique({ where: { deliveryKey: key.deliveryKey }, select: { dueAt: true } });
  const record = await appendExecutionDispatch(tx, { ...identity, inputHash: autopilotExecutionInputHash(rule), dueAt: existing?.dueAt ?? options.deadline?.at ?? options.dueAt ?? rule.nextRunAt });
  collectExecutionDispatch(tx, record.reference.dispatchId);
  return record.reference;
}
/** The native commit holds Probe, so this hook never locks its parent Rule.
 * The link was committed atomically with probe admission before dispatch. */
export async function wakeAutopilotProbe(tx: Tx, id: string): Promise<string[]> {
  const { epoch } = await readExecutionAdmission(tx);
  const probe = await tx.outboundProbe.findUnique({ where: { id }, select: { status: true, deploymentEpoch: true } });
  if (!probe || probe.deploymentEpoch !== epoch || !["completed", "failed", "cancelled"].includes(probe.status)) return [];
  const rule = await tx.autopilotRule.findUnique({ where: { executionProbeId: id } });
  if (!rule || rule.deploymentEpoch !== epoch || !rule.executionCycleId || !["active", "running"].includes(rule.status)) return [];
  return [(await appendRule(tx, rule, { wakeKind: `rss.${id.replaceAll("-", "")}`, dueAt: await databaseNow(tx) })).dispatchId];
}
export async function queueAutopilotRule(tx: Tx, id: string): Promise<ExecutionDispatchReference | null> {
  const { epoch } = await readExecutionAdmission(tx);
  const rule = await tx.autopilotRule.findUnique({ where: { id } });
  if (!rule || rule.deploymentEpoch !== epoch || rule.sourceKind !== "rss" || !["active", "running"].includes(rule.status)) return null;
  return appendRule(tx, rule);
}
async function lockRuleActor(tx: Tx, rule: Pick<AutopilotRule,"workspaceId"|"createdByUserId">) {
  if (rule.createdByUserId) {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${rule.createdByUserId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "WorkspaceMember" WHERE "workspaceId"=${rule.workspaceId}::uuid AND "userId"=${rule.createdByUserId}::uuid FOR SHARE`;
  }
  await lockWorkspaceUsage(tx,rule.workspaceId);
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${rule.workspaceId}::uuid FOR SHARE`;
}
async function actorAvailable(tx: Tx, rule: Pick<AutopilotRule,"workspaceId"|"createdByUserId">) {
  if (!rule.createdByUserId) return false;
  const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: rule.workspaceId, userId: rule.createdByUserId } }, include: { user: { select: { deletedAt: true } }, workspace: { select: { status: true } } } });
  return !!member && !member.user.deletedAt && roleHasWorkspaceCapability(member.role,"processing.consume") && workspaceAllowsCapability({ role: member.role, status: member.workspace.status },"processing.consume");
}
/** Registers accepted metadata only. Physical execution rechecks every fence. */
export async function recoverAutopilotRule(tx:Tx,id:string,wakeKind?:string):Promise<string[]>{
  const {epoch}=await readExecutionAdmission(tx),row=await tx.autopilotRule.findUnique({where:{id}});
  if(!row||row.deploymentEpoch!==epoch||row.sourceKind!=="rss"||!["active","running"].includes(row.status))return [];
  const ids=[(await appendRule(tx,row,wakeKind?{wakeKind}:{})).dispatchId];
  if(row.operationDeadlineAt)ids.push((await appendRule(tx,row,{deadline:{kind:"operation",at:row.operationDeadlineAt}})).dispatchId);
  if(row.claimToken&&row.leaseExpiresAt)ids.push((await appendRule(tx,row,{deadline:{kind:"lease",at:row.leaseExpiresAt}})).dispatchId);
  if(row.executionProbeId)ids.push(...await queueOutboundProbeExecution(tx,row.executionProbeId));
  return ids;
}
export type AutopilotExecutionResult = { kind: "complete" | "superseded" } | { kind: "sleep" | "wait"; dueAt: Date };
export interface AutopilotExecutionDependencies {
  database: PrismaClient;
  probe: Pick<OutboundProbeService, "admitWithinTransaction" | "get">;
  register(ids: readonly string[]): Promise<void>;
  importEpisode(input: { scope: ActorScope; plan: AutopilotCycleInput; episode: RssEpisodeInput; finalUrl: string; reference: ExecutionDispatchReference; claimToken: string }): Promise<{ count: number; refusal?: "deferred" | "too_long" | "brand_profile" }>;
}
type Prepared = { result: AutopilotExecutionResult; ids: string[] } | { action: "read_source" | "episode"; row: AutopilotRule; input: AutopilotCycleInput; claimToken: string; ids: string[] };

/** One exact source action. No coordinator lease spans the native probe wait. */
export class AutopilotExecution {
  constructor(private readonly deps: AutopilotExecutionDependencies) {}
  async run(value: ExecutionDispatchReference): Promise<AutopilotExecutionResult> {
    const reference = executionDispatchReferenceSchema.parse(value);
    const prepared = await this.deps.database.$transaction<Prepared>(async tx => {
      const admission = await readExecutionAdmission(tx), record = await readExecutionDispatch(tx, reference.dispatchId);
      if (reference.kind !== "operation_driver" || reference.subject.kind !== "autopilot_rule" || admission.epoch !== reference.deploymentEpoch || !record || JSON.stringify(record.reference) !== JSON.stringify(reference)) return { result: { kind: "superseded" } as AutopilotExecutionResult, ids: [] as string[] };
      const initial = await tx.autopilotRule.findUnique({ where: { id: reference.subject.id } });
      if (!initial) return { result: { kind: "superseded" } as AutopilotExecutionResult, ids: [] as string[] };
      await lockRuleActor(tx,initial);
      let rule = await tx.autopilotRule.findUniqueOrThrow({ where: { id: initial.id } });
      if (rule.executionCycleId) {
        await tx.$queryRaw`SELECT "id" FROM "AutopilotRule" WHERE "id"=${rule.id}::uuid FOR NO KEY UPDATE`;
        rule = await tx.autopilotRule.findUniqueOrThrow({ where: { id: initial.id } });
      }
      if (rule.deploymentEpoch !== admission.epoch || rule.generation !== reference.generation || autopilotExecutionInputHash(rule) !== reference.inputHash || rule.sourceKind !== "rss" || !["active", "running"].includes(rule.status)) {
        return { result: { kind: "superseded" } as AutopilotExecutionResult, ids: await this.repair(tx,rule) };
      }
      const now = await databaseNow(tx);
      if (record.observedDeadlineAt && record.observedDeadlineAt > now) return { result: { kind: "sleep", dueAt: record.observedDeadlineAt }, ids: [] };
      if (rule.nextRunAt > now) return { result: { kind: "sleep", dueAt: rule.nextRunAt } as AutopilotExecutionResult, ids: [] };
      if (rule.executionCycleId) {
        if (!await actorAvailable(tx,rule)) return { result: { kind: "complete" }, ids: await this.pauseCycle(tx,rule,"acting_member","Its acting member can no longer process videos. A Workspace Owner or Admin can take over this rule.") };
        const planReason = await autopilotPlanPauseReason(tx,rule);
        if (planReason) return { result: { kind: "complete" }, ids: await this.pauseCycle(tx,rule,"plan",planReason) };
        if (!rule.executionProbeId || !rule.operationDeadlineAt) throw Error("autopilot_cycle_input_invalid");
        if (rule.operationDeadlineAt <= now) return { result: { kind: "complete" }, ids: await this.failCycle(tx,rule,"autopilot_cycle_deadline_elapsed") };
        const probe = await tx.outboundProbe.findUnique({ where: { id: rule.executionProbeId } });
        if (!probe) return { result: { kind: "complete" }, ids: await this.failCycle(tx,rule,"autopilot_probe_missing") };
        if (["queued", "processing"].includes(probe.status)) return { result: { kind: "wait", dueAt: rule.operationDeadlineAt } as AutopilotExecutionResult, ids: await this.repair(tx,rule) };
        if (probe.status !== "completed") return { result: { kind: "complete" }, ids: await this.failCycle(tx,rule,probe.errorCode ?? "autopilot_source_probe_failed") };
        if (rule.claimToken && rule.leaseExpiresAt) {
          if (rule.leaseExpiresAt > now) return { result: { kind: "wait", dueAt: rule.leaseExpiresAt }, ids: await this.repair(tx,rule) };
          const recovered = await tx.autopilotRule.update({ where: { id: rule.id }, data: { generation: { increment: 1 }, claimToken: null, leaseExpiresAt: null } });
          return { result: { kind: "complete" }, ids: [(await appendRule(tx,recovered)).dispatchId,(await appendRule(tx,recovered,{ deadline: { kind: "operation", at: recovered.operationDeadlineAt! } })).dispatchId] };
        }
        const input = autopilotCycleInputSchema.parse(rule.executionInput);
        if (operationFingerprint(input) !== rule.executionInputHash) throw Error("autopilot_cycle_input_invalid");
        const token = randomUUID(), leaseExpiresAt = new Date(Math.min(now.getTime()+AUTOPILOT_LEASE_MS,rule.operationDeadlineAt.getTime()));
        const claimed = await tx.autopilotRule.update({ where: { id: rule.id }, data: { claimToken: token, leaseExpiresAt } });
        return { action: rule.executionSelection === null ? "read_source" : "episode", row: claimed, input, claimToken: token,
          ids: [(await appendRule(tx,claimed,{ deadline: { kind: "lease", at: leaseExpiresAt } })).dispatchId, (await appendRule(tx,claimed,{ deadline: { kind: "operation", at: rule.operationDeadlineAt } })).dispatchId] };
      }
      assertExecutionAdmissionOpen(admission);
      const plan = await lockAutopilotImportPlan(tx, rule);
      rule = await tx.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } });
      if (rule.generation !== reference.generation || rule.deploymentEpoch !== admission.epoch || autopilotExecutionInputHash(rule) !== reference.inputHash) {
        return { result: { kind: "superseded" }, ids: await this.repair(tx,rule) };
      }
      if (!await actorAvailable(tx,rule)) return { result: { kind: "complete" }, ids: await this.pauseCycle(tx,rule,"acting_member","Its acting member can no longer process videos. A Workspace Owner or Admin can take over this rule.") };
      const refusal = await autopilotPlanPauseReason(tx, rule);
      if (refusal) return { result: { kind: "complete" }, ids: await this.pauseCycle(tx,rule,"plan",refusal) };
      const input = autopilotCycleInputSchema.parse({ ...plan, rssUrl: rule.rssUrl!, titlePrefix: rule.titlePrefix, intervalMinutes: rule.intervalMinutes,
        selectionRule: { initializedAt: rule.initializedAt?.toISOString() ?? null, initialImportMode: rule.initialImportMode, initialImportCount: rule.initialImportCount, maxEpisodesPerRun: rule.maxEpisodesPerRun, lastSeenEpisodeId: rule.lastSeenEpisodeId, lastSeenPublishedAt: rule.lastSeenPublishedAt?.toISOString() ?? null } });
      if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 65536) throw Error("autopilot_cycle_input_too_large");
      const cycleId = randomUUID(), dueAt = rule.nextRunAt, operationDeadlineAt = new Date(dueAt.getTime() + AUTOPILOT_CYCLE_DEADLINE_MS);
      if (operationDeadlineAt <= now) return { result: { kind: "complete" }, ids: await this.failCycle(tx,rule,"autopilot_cycle_deadline_elapsed") };
      const child = await this.deps.probe.admitWithinTransaction(tx, { workspaceId: rule.workspaceId, actorUserId: rule.createdByUserId! }, { kind: "rss_feed", url: input.rssUrl, etag: rule.initializedAt ? rule.etag : null, lastModified: rule.initializedAt ? rule.lastModified : null }, `autopilot:${rule.id}:${cycleId}`);
      const updated = await tx.autopilotRule.update({ where: { id: rule.id }, data: { generation: { increment: 1 }, status: "running", executionCycleId: cycleId, executionDueAt: dueAt, operationDeadlineAt, executionInput: input as unknown as Prisma.InputJsonValue, executionInputHash: operationFingerprint(input), executionProbeId: child.row.id, claimToken: null, leaseExpiresAt: null } });
      return { result: { kind: "complete" } as AutopilotExecutionResult, ids: [...child.ids, (await appendRule(tx, updated)).dispatchId, (await appendRule(tx, updated, { deadline: { kind: "operation", at: operationDeadlineAt } })).dispatchId] };
    });
    if (prepared.ids.length) await this.deps.register(prepared.ids);
    if ("result" in prepared) return prepared.result;
    try { return await this.runAction(reference,prepared); }
    catch (error) {
      if (error instanceof ExecutionDispatchPendingError) {
        await this.deps.database.$transaction(async tx => {
          const row = await this.owned(tx,reference,prepared.claimToken);
          if (row) await tx.autopilotRule.update({where:{id:row.id},data:{claimToken:null,leaseExpiresAt:null}});
        });
        throw error;
      }
      if (error instanceof ExecutionDispatchError) throw error;
      const ids = await this.deps.database.$transaction(async tx => {
        const row = await this.owned(tx,reference,prepared.claimToken);
        if (!row) return null;
        if (!await actorAvailable(tx,row)) return this.pauseCycle(tx,row,"acting_member","Its acting member can no longer process videos. A Workspace Owner or Admin can take over this rule.");
        const planReason = await autopilotPlanPauseReason(tx,row);
        return planReason ? this.pauseCycle(tx,row,"plan",planReason) : this.failCycle(tx,row,"autopilot_cycle_failed");
      });
      // A commit may have succeeded before registration lost its response.
      // Retry the original reference so its replay repairs the new obligation.
      if (ids === null) throw error;
      await this.deps.register(ids);
      return { kind: "complete" };
    }
  }

  private async repair(tx:Tx,row:AutopilotRule){return recoverAutopilotRule(tx,row.id);}

  private async runAction(reference: ExecutionDispatchReference, prepared: Extract<Prepared,{ action: string }>): Promise<AutopilotExecutionResult> {
    const snapshot = await this.deps.probe.get({ workspaceId: prepared.row.workspaceId, actorUserId: prepared.row.createdByUserId! },prepared.row.executionProbeId!);
    if (snapshot.status !== "ready" || !snapshot.result) throw Error("autopilot_source_probe_failed");
    const feed = rssFeedSnapshotSchema.parse(snapshot.result);
    if (prepared.action === "episode") {
      const selection = autopilotCycleSelectionSchema.parse(prepared.row.executionSelection);
      const index = selection.indices[prepared.row.executionCursor], episode = index === undefined ? undefined : feed.episodes[index];
      if (!episode || operationFingerprint(episode) !== selection.episodeHashes[prepared.row.executionCursor]) throw Error("autopilot_selected_episode_invalid");
      const admitted = await this.deps.importEpisode({ scope: { workspaceId: prepared.row.workspaceId, actorUserId: prepared.row.createdByUserId! }, plan: prepared.input, episode, finalUrl: feed.finalUrl, reference, claimToken: prepared.claimToken });
      const ids = await this.deps.database.$transaction(async tx => {
        const row = await this.owned(tx,reference,prepared.claimToken);
        if (!row) return null;
        if (admitted.refusal === "brand_profile") return this.pauseCycle(tx,row,"brand_profile","The Recipe's Brand Profile cannot be applied. Fix the Brand Kit or Recipe, then resume this rule.");
        if (admitted.refusal === "deferred") return this.completeCycle(tx,row,prepared.input,feed,selection.shouldAdvanceCursor,true);
        const nextCursor = row.executionCursor + 1;
        if (nextCursor === selection.indices.length) return this.completeCycle(tx,row,prepared.input,feed,selection.shouldAdvanceCursor,false);
        const next = await tx.autopilotRule.update({ where: { id: row.id }, data: { generation: { increment: 1 }, executionCursor: nextCursor, claimToken: null, leaseExpiresAt: null } });
        return [(await appendRule(tx,next)).dispatchId, (await appendRule(tx,next,{ deadline: { kind: "operation", at: next.operationDeadlineAt! } })).dispatchId];
      });
      if (ids === null) return { kind: "superseded" };
      await this.deps.register(ids);
      return { kind: "complete" };
    }
    const ids = await this.deps.database.$transaction(async tx => {
      const row = await this.owned(tx,reference,prepared.claimToken);
      if (!row) return null;
      if (feed.notModified) return this.completeCycle(tx,row,prepared.input,feed,true,false);
      const existing = await tx.autopilotEpisode.findMany({ where: { ruleId: row.id, episodeId: { in: feed.episodes.map(episode=>episode.id) } }, select: { episodeId: true } });
      const selectionRule = { ...prepared.input.selectionRule, initializedAt: prepared.input.selectionRule.initializedAt ? new Date(prepared.input.selectionRule.initializedAt) : null, lastSeenPublishedAt: prepared.input.selectionRule.lastSeenPublishedAt ? new Date(prepared.input.selectionRule.lastSeenPublishedAt) : null };
      const selected = selectAutopilotEpisodes(feed.episodes,new Set(existing.map(item=>item.episodeId)),selectionRule);
      const indices = [...new Set(selected.episodes.map(episode=>feed.episodes.findIndex(item=>item.id===episode.id)))];
      if (!indices.length) return this.completeCycle(tx,row,prepared.input,feed,selected.shouldAdvanceCursor,false);
      const next = await tx.autopilotRule.update({ where: { id: row.id }, data: { generation: { increment: 1 }, executionSelection: { indices, episodeHashes: indices.map(index=>operationFingerprint(feed.episodes[index])), shouldAdvanceCursor: selected.shouldAdvanceCursor, deferred: false }, executionCursor: 0, claimToken: null, leaseExpiresAt: null } });
      return [(await appendRule(tx,next)).dispatchId, (await appendRule(tx,next,{ deadline: { kind: "operation", at: next.operationDeadlineAt! } })).dispatchId];
    });
    if (ids === null) return { kind: "superseded" };
    await this.deps.register(ids);
    return { kind: "complete" };
  }

  /** Called after the intake has locked its actor, Workspace, Recipe and Rule.
   * No new owner or lease is issued here; this only validates the admitted one. */
  async assertIntakeWithinTransaction(tx: Tx, input: { reference: ExecutionDispatchReference; claimToken: string; scope: ActorScope; episode: RssEpisodeInput }) {
    const { reference } = input;
    if ((await readExecutionAdmission(tx)).epoch !== reference.deploymentEpoch || reference.kind !== "operation_driver" || reference.subject.kind !== "autopilot_rule") throw Error("autopilot_coordinator_superseded");
    const record = await readExecutionDispatch(tx,reference.dispatchId), row = await tx.autopilotRule.findUnique({ where: { id: reference.subject.id } }), now = await databaseNow(tx);
    if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference) || !row || row.workspaceId !== input.scope.workspaceId || row.createdByUserId !== input.scope.actorUserId || row.status !== "running" || row.deploymentEpoch !== reference.deploymentEpoch || row.generation !== reference.generation || autopilotExecutionInputHash(row) !== reference.inputHash || row.claimToken !== input.claimToken || !row.leaseExpiresAt || row.leaseExpiresAt <= now || !row.operationDeadlineAt || row.operationDeadlineAt <= now) throw Error("autopilot_coordinator_superseded");
    const selection = autopilotCycleSelectionSchema.parse(row.executionSelection);
    if (selection.episodeHashes[row.executionCursor] !== operationFingerprint(input.episode) || !await actorAvailable(tx,row) || await autopilotPlanPauseReason(tx,row)) throw Error("autopilot_coordinator_superseded");
  }

  private async pauseCycle(tx: Tx, row: AutopilotRule, kind: AutopilotPauseKind, reason: string): Promise<string[]> {
    if(kind==="acting_member"){
      const user=row.createdByUserId?await tx.user.findUnique({where:{id:row.createdByUserId},select:{firstName:true,lastName:true}}):null;
      const name=[user?.firstName,user?.lastName].filter(Boolean).join(" ")||"Its acting member";
      reason=`${name} can no longer run this rule (account deleted, removed from the Workspace, or not allowed to process videos). A Workspace Owner or Admin can take it over to resume it.`;
    }else if(kind==="brand_profile"){
      const parsed=autopilotCycleInputSchema.safeParse(row.executionInput),id=parsed.success?parsed.data.recipe.brandProfileId:null;
      const profile=id?await tx.brandProfile.findUnique({where:{id},select:{name:true}}):null;
      reason=`Brand Profile "${profile?.name??"removed profile"}" could not be applied. Fix it in Brand Kit or in the rule's Recipe, then turn the rule back on. Moving the rule to another Recipe also resumes it.`;
    }
    await tx.autopilotRule.update({ where: { id: row.id }, data: {
      generation: { increment: 1 }, status: "paused", pauseKind: kind, claimToken: null, leaseExpiresAt: null,
      executionCycleId: null, executionDueAt: null, operationDeadlineAt: null, executionInput: Prisma.DbNull, executionInputHash: null, executionProbeId: null, executionSelection: Prisma.DbNull, executionCursor: 0,
      lastError: reason, lastCheckedAt: await databaseNow(tx),
    } });
    return [];
  }

  private async failCycle(tx: Tx, row: AutopilotRule, code: string) {
    const now = await databaseNow(tx), failures = row.consecutiveFailures + 1;
    const next = await tx.autopilotRule.update({ where: { id: row.id }, data: {
      generation: { increment: 1 }, status: failures >= AUTOPILOT_MAX_CONSECUTIVE_FAILURES || ["rss_invalid_xml","rss_no_media_episodes","rss_unsupported_document","remote_url_unsafe"].includes(code) ? "failed" : "active", claimToken: null, leaseExpiresAt: null,
      executionCycleId: null, executionDueAt: null, operationDeadlineAt: null, executionInput: Prisma.DbNull, executionInputHash: null, executionProbeId: null, executionSelection: Prisma.DbNull, executionCursor: 0,
      consecutiveFailures: failures, lastError: code, lastCheckedAt: now, nextRunAt: new Date(now.getTime()+autopilotRetryDelayMs(failures,row.intervalMinutes)),
    } });
    return next.status === "active" ? [(await appendRule(tx,next)).dispatchId] : [];
  }

  private async completeCycle(tx: Tx, row: AutopilotRule, input: AutopilotCycleInput, feed: RssFeedSnapshot, shouldAdvanceCursor: boolean, deferred: boolean) {
    const now = await databaseNow(tx), head = feed.episodes[0];
    const advance = !deferred && (!input.selectionRule.initializedAt || shouldAdvanceCursor);
    const next = await tx.autopilotRule.update({ where: { id: row.id }, data: { generation: { increment: 1 }, status: "active", executionCycleId: null, executionDueAt: null, operationDeadlineAt: null, executionInput: Prisma.DbNull, executionInputHash: null, executionProbeId: null, executionSelection: Prisma.DbNull, executionCursor: 0, claimToken: null, leaseExpiresAt: null,
      lastCheckedAt: now, lastSuccessAt: now, lastError: null, consecutiveFailures: 0, nextRunAt: new Date(now.getTime()+input.intervalMinutes*60_000),
      ...(!feed.notModified ? { initializedAt: row.initializedAt ?? (deferred ? null : now), ...(advance ? { lastSeenEpisodeId: head?.id ?? row.lastSeenEpisodeId, lastSeenPublishedAt: head?.publishedAt ? new Date(head.publishedAt) : row.lastSeenPublishedAt } : {}), etag: shouldAdvanceCursor && !deferred ? feed.etag : null, lastModified: shouldAdvanceCursor && !deferred ? feed.lastModified : null, feedTitle: feed.title } : {}),
    } });
    return [(await appendRule(tx,next)).dispatchId];
  }

  private async owned(tx: Tx, reference: ExecutionDispatchReference, token: string) {
    if ((await readExecutionAdmission(tx)).epoch !== reference.deploymentEpoch) return null;
    const initial = await tx.autopilotRule.findUnique({ where: { id: reference.subject.id } });
    if (!initial) return null;
    await lockRuleActor(tx,initial);
    await tx.$queryRaw`SELECT "id" FROM "AutopilotRule" WHERE "id"=${initial.id}::uuid FOR NO KEY UPDATE`;
    const row = await tx.autopilotRule.findUniqueOrThrow({ where: { id: initial.id } }), now = await databaseNow(tx);
    return row.status === "running" && row.deploymentEpoch === reference.deploymentEpoch && row.generation === reference.generation && autopilotExecutionInputHash(row) === reference.inputHash && row.claimToken === token && row.leaseExpiresAt && row.leaseExpiresAt > now && row.operationDeadlineAt && row.operationDeadlineAt > now ? row : null;
  }
}
