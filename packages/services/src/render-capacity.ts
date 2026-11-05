import { planLimits } from "@narriflow/validators";
import { Prisma } from "@prisma/client";
import { databaseNow } from "./execution-clock";
import { appendExecutionDispatch, executionDispatchIdentity } from "./execution-dispatch";
import { accessibleProjectSql } from "./project-access";

type Tx = Prisma.TransactionClient;

const CAPACITY_LOCK = "render-capacity-admission";
/** Waiters recheck on this timer. A release wake is only a faster hint. */
const RETRY_MS = 5 * 60_000;
const RETRY_JITTER_MS = 60_000;
/** A waiter whose timer lapsed this long ago has lost its Workflow, so it holds no place in line. */
const STALE_WAITER_MS = 15 * 60_000;
/** Each ten minutes in line moves a waiter up one place, so no Workspace starves. */
const AGE_MS_PER_PLACE = 10 * 60_000;
const MAX_RANKED_WAITERS = 2_000;
/** Delivered inside the executor's own command, so a release stays cheap. */
const MAX_WAKES_PER_RELEASE = 8;

export interface RenderWaiter {
  id: string;
  workspaceId: string;
  tier: string;
  waitingSince: Date;
}

function byWaitThenId(left: RenderWaiter, right: RenderWaiter) {
  return left.waitingSince.getTime() - right.waitingSince.getTime() || left.id.localeCompare(right.id);
}

/** Fair queuing: a waiter's place is how much of the Workspace's work is ahead of
 * it, scaled by plan weight and reduced by time waited. */
export function orderRenderWaiters(waiters: readonly RenderWaiter[], active: ReadonlyMap<string, number>, now: Date): RenderWaiter[] {
  const seen = new Map<string, number>();
  const placed = [...waiters].sort(byWaitThenId).map(waiter => {
    const ahead = (active.get(waiter.workspaceId) ?? 0) + (seen.get(waiter.workspaceId) ?? 0);
    seen.set(waiter.workspaceId, (seen.get(waiter.workspaceId) ?? 0) + 1);
    const waitedMs = Math.max(0, now.getTime() - waiter.waitingSince.getTime());
    return { waiter, place: (ahead + 1) / planLimits(waiter.tier).renderQueueWeight - waitedMs / AGE_MS_PER_PLACE };
  });
  return placed.sort((left, right) => left.place - right.place || byWaitThenId(left.waiter, right.waiter)).map(entry => entry.waiter);
}

/** Spread by group so a burst of waiters does not recheck in one moment. */
export function renderCapacityRetryAt(groupId: string, now: Date): Date {
  const spread = Number.parseInt(groupId.replaceAll("-", "").slice(0, 8), 16) % RETRY_JITTER_MS;
  return new Date(now.getTime() + RETRY_MS + spread);
}

/** A group holds a slot from admission until it settles or its deadline passes. */
async function readActive(tx: Tx, deploymentEpoch: number, now: Date, excludeGroupId?: string) {
  const rows = await tx.$queryRaw<Array<{ workspaceId: string; active: number }>>`
    SELECT project."workspaceId", COUNT(*)::int AS "active"
    FROM "RenderGroup" render_group
    JOIN "WorkflowRun" run ON run.id = render_group."workflowRunId"
    JOIN "Project" project ON project.id = run."projectId"
    WHERE render_group."deploymentEpoch" = ${deploymentEpoch} AND render_group.status IN ('queued', 'running')
      AND render_group."operationDeadlineAt" > (${now}::timestamp)
      AND render_group.id <> ${excludeGroupId ?? "00000000-0000-0000-0000-000000000000"}::uuid
    GROUP BY project."workspaceId"`;
  const active = new Map(rows.map(row => [row.workspaceId, row.active]));
  return { active, total: rows.reduce((sum, row) => sum + row.active, 0) };
}

async function readWaiters(tx: Tx, deploymentEpoch: number, now: Date) {
  const liveAfter = new Date(now.getTime() - STALE_WAITER_MS);
  return tx.$queryRaw<Array<RenderWaiter & { generation: number }>>`
    SELECT render_group.id, render_group.generation, project."workspaceId", workspace."pricingTier"::text AS "tier",
      render_group."capacityWaitSince" AS "waitingSince"
    FROM "RenderGroup" render_group
    JOIN "WorkflowRun" run ON run.id = render_group."workflowRunId"
    JOIN "Project" project ON project.id = run."projectId"
    JOIN "Workspace" workspace ON workspace.id = project."workspaceId"
    WHERE render_group."deploymentEpoch" = ${deploymentEpoch} AND render_group.status = 'queued'
      AND render_group."capacityWaitSince" IS NOT NULL AND render_group."nextAttemptAt" > (${liveAfter}::timestamp)
      AND workspace.status = 'active' AND ${accessibleProjectSql("project", Prisma.sql`(${now}::timestamp)`)}
    ORDER BY render_group."capacityWaitSince", render_group.id LIMIT ${MAX_RANKED_WAITERS}`;
}

/** Caller holds this group's locks. Only this group is written under the capacity
 * lock, so no lock cycle can form. Not holding a slot leaves it unowned and uncharged. */
export async function admitRenderCapacityWithinTransaction(tx: Tx, input: {
  group: { id: string; deploymentEpoch: number; capacityWaitSince: Date | null };
  workspaceId: string; tier: string; maxAdmittedGroups: number;
}): Promise<{ admitted: true; waitedMs: number } | { admitted: false; retryAt: Date }> {
  const { group } = input;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK}, 0)) IS NULL AS "locked"`;
  const now = await databaseNow(tx);
  const { active, total } = await readActive(tx, group.deploymentEpoch, now);
  const free = input.maxAdmittedGroups - total;
  const self: RenderWaiter = { id: group.id, workspaceId: input.workspaceId, tier: input.tier, waitingSince: group.capacityWaitSince ?? now };
  let admitted = false;
  if (free > 0) {
    const waiters: RenderWaiter[] = (await readWaiters(tx, group.deploymentEpoch, now)).filter(waiter => waiter.id !== group.id);
    admitted = orderRenderWaiters([...waiters, self], active, now).slice(0, free).some(waiter => waiter.id === group.id);
  }
  if (admitted) {
    if (group.capacityWaitSince) await tx.renderGroup.update({ where: { id: group.id }, data: { capacityWaitSince: null, nextAttemptAt: null } });
    return { admitted: true, waitedMs: now.getTime() - self.waitingSince.getTime() };
  }
  const retryAt = renderCapacityRetryAt(group.id, now);
  await tx.renderGroup.update({ where: { id: group.id }, data: { capacityWaitSince: self.waitingSince, nextAttemptAt: retryAt } });
  return { admitted: false, retryAt };
}

/** A hint only, so it takes no capacity lock. Every woken group still has to win
 * its place under the lock, and a missed hint costs at most one retry timer. */
export async function appendRenderCapacityWakesWithinTransaction(tx: Tx, input: {
  releasedGroupId: string; deploymentEpoch: number; maxAdmittedGroups: number;
}): Promise<string[]> {
  const now = await databaseNow(tx);
  const { active, total } = await readActive(tx, input.deploymentEpoch, now, input.releasedGroupId);
  const free = input.maxAdmittedGroups - total;
  if (free <= 0) return [];
  const waiters = await readWaiters(tx, input.deploymentEpoch, now);
  if (!waiters.length) return [];
  const generations = new Map(waiters.map(waiter => [waiter.id, waiter.generation]));
  const wakeKind = `cap_${input.releasedGroupId.replaceAll("-", "")}`;
  const dispatchIds: string[] = [];
  for (const waiter of orderRenderWaiters(waiters, active, now).slice(0, Math.min(free, MAX_WAKES_PER_RELEASE))) {
    const identity = { deploymentEpoch: input.deploymentEpoch, kind: "operation_driver" as const,
      subject: { kind: "render_group" as const, id: waiter.id }, generation: generations.get(waiter.id)! };
    const driver = await tx.executionDispatch.findUnique({ where: { deliveryKey: (await executionDispatchIdentity(identity)).deliveryKey }, select: { inputHash: true } });
    if (!driver) continue;
    const replayed = await tx.executionDispatch.findUnique({ where: { deliveryKey: (await executionDispatchIdentity({ ...identity, wakeKind })).deliveryKey }, select: { dueAt: true } });
    const wake = await appendExecutionDispatch(tx, { ...identity, inputHash: driver.inputHash, dueAt: replayed?.dueAt ?? now, wakeKind });
    dispatchIds.push(wake.reference.dispatchId);
  }
  return dispatchIds;
}
