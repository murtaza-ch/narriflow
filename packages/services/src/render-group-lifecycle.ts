import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { accessibleProjectWhere } from "./project-access";
import { syncClipExportAggregates } from "./clip-export-aggregates";
import { flushWorkspaceEvents } from "./workspace-event";
import { appendWorkflowEvent } from "./workflow-event-append";
import { isWorkflowRedisDeliveryEnabled } from "./workflow.service";
import {
  type ClaimedRenderGroupAttempt,
  type FinishRenderGroupExecution,
  type ReleaseRenderGroupExecution,
  type RenderGroupAttemptRef,
  type RenderGroupConfiguration,
  type RenderGroupRef,
  type StartRenderGroupExecution,
  deriveRenderGroupSettlement,
  deriveRenderParentSettlement,
  renderGroupChargeTransition,
  renderGroupExportIdentity,
} from "./render-group-contract";

type Tx = Prisma.TransactionClient;
export interface RenderGroupAdmission {
  readonly configuration: RenderGroupConfiguration;
  readonly variantIds: readonly string[];
}
export class RenderGroupAttemptLost extends Error {
  readonly code = "render_group_attempt_lost";
  constructor(readonly attempt: RenderGroupAttemptRef) {
    super(`Render group ${attempt.groupId} is no longer owned`);
    this.name = "RenderGroupAttemptLost";
  }
}
export async function renderGroupDatabaseNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
  if (!rows[0]) throw new Error("Database clock unavailable");
  return rows[0].now;
}

/** Caller holds the project admission lock and parent lock. The partition is
 * admitted atomically with the parent's frozen membership, never incrementally. */
export async function admitRenderGroupsWithinTransaction(
  tx: Tx,
  input: {
    workflowRunId: string;
    projectId: string;
    groups: readonly RenderGroupAdmission[];
  },
): Promise<RenderGroupRef[]> {
  const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: input.workflowRunId } });
  if (run.renderWorkSetGeneration) {
    const existing = await tx.renderGroup.findMany({
      where: { workflowRunId: run.id },
      include: { members: true },
    });
    if (
      existing.length !== input.groups.length ||
      existing.some(
        (g) =>
          !input.groups.some(
            (candidate) =>
              g.clipId === candidate.configuration.clipId &&
              g.exportIdentity === renderGroupExportIdentity(candidate.configuration) &&
              g.members.length === candidate.variantIds.length &&
              g.members.every((m) => candidate.variantIds.includes(m.clipRenderId)),
          ),
      )
    )
      throw new Error("Render group membership is immutable");
    return input.groups.map((candidate) => {
      const group = existing.find(
        (g) =>
          g.clipId === candidate.configuration.clipId &&
          g.exportIdentity === renderGroupExportIdentity(candidate.configuration),
      )!;
      return {
        workflowRunId: run.id,
        workSetGeneration: run.renderWorkSetGeneration!,
        groupId: group.id,
      };
    });
  }
  const variants = await tx.clipRender.findMany({
    where: { workflowRunId: run.id },
    include: {
      clip: { select: { projectId: true, editorRevision: true } },
      exportVariant: { include: { export: true } },
    },
  });
  const ids = input.groups.flatMap((g) => [...g.variantIds]);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== run.requestedCount ||
    variants.length !== ids.length ||
    variants.some((v) => !ids.includes(v.id))
  )
    throw new Error("Incomplete render group partition");
  const identities = new Set<string>();
  for (const group of input.groups) {
    const config = group.configuration;
    const identity = `${config.clipId}:${renderGroupExportIdentity(config)}`;
    if (!group.variantIds.length || identities.has(identity))
      throw new Error("Duplicate or empty render group");
    identities.add(identity);
    for (const id of group.variantIds) {
      const variant = variants.find((v) => v.id === id)!;
      const frozen = variant.exportVariant?.export;
      if (
        variant.clip.projectId !== input.projectId ||
        variant.clipId !== config.clipId ||
        variant.resolution !== config.resolution ||
        (variant.exportVariant?.exportId ?? null) !== config.exportId ||
        (variant.editorRevision ?? variant.clip.editorRevision) !== config.editorRevision ||
        (frozen &&
          (frozen.resolution !== config.resolution ||
            frozen.watermark !== config.watermark ||
            frozen.editorRevision !== config.editorRevision ||
            frozen.clipId !== config.clipId)) ||
        (variant.exportVariant &&
          (variant.exportVariant.resolution !== config.resolution ||
            variant.exportVariant.watermark !== config.watermark))
      )
        throw new Error("Render group configuration mismatch");
    }
  }
  const generation = run.renderWorkSetGeneration ?? randomUUID();
  if (!run.renderWorkSetGeneration)
    await tx.workflowRun.update({
      where: { id: run.id },
      data: { renderWorkSetGeneration: generation },
    });
  const result: RenderGroupRef[] = [];
  for (const group of input.groups) {
    const exportIdentity = renderGroupExportIdentity(group.configuration);
    const row = await tx.renderGroup.create({
      data: {
        workflowRunId: run.id,
        workSetGeneration: generation,
        clipId: group.configuration.clipId,
        exportIdentity,
        members: { create: group.variantIds.map((clipRenderId) => ({ clipRenderId })) },
      },
    });
    result.push({ workflowRunId: run.id, workSetGeneration: generation, groupId: row.id });
  }
  return result;
}

/** Reconcile historical membership under parent/group locks. Editor deletion or
 * reassignment cannot erase the requested denominator or authorize stale writes. */
async function memberSnapshot(tx: Tx, group: RenderGroupRef) {
  await tx.$queryRaw`SELECT "clipRenderId" FROM "RenderGroupMember" WHERE "groupId" = ${group.groupId}::uuid ORDER BY "clipRenderId" FOR UPDATE`;
  const members = await tx.renderGroupMember.findMany({
    where: { groupId: group.groupId },
    orderBy: { clipRenderId: "asc" },
  });
  await tx.$queryRaw`SELECT "id" FROM "ClipRender" WHERE "id" IN (SELECT "clipRenderId" FROM "RenderGroupMember" WHERE "groupId" = ${group.groupId}::uuid) ORDER BY "id" FOR UPDATE`;
  const variants = await tx.clipRender.findMany({
    where: { id: { in: members.map((m) => m.clipRenderId) } },
  });
  const now = await renderGroupDatabaseNow(tx);
  return Promise.all(
    members.map(async (m) => {
      const variant = variants.find((v) => v.id === m.clipRenderId);
      const superseded =
        m.invalidatedAt !== null || !variant || variant.workflowRunId !== group.workflowRunId;
      if (superseded && !m.invalidatedAt)
        await tx.renderGroupMember.update({
          where: { groupId_clipRenderId: { groupId: group.groupId, clipRenderId: m.clipRenderId } },
          data: { invalidatedAt: now },
        });
      return {
        clipRenderId: m.clipRenderId,
        status: superseded ? ("superseded" as const) : variant!.status,
        failureDisposition: variant?.failureDisposition ?? null,
        variant: superseded ? null : variant!,
      };
    }),
  );
}

/** Caller holds the parent lock. Reconcile queued/terminal groups too, so
 * superseded settled members never masquerade as current successful outputs. */
export async function renderGroupParentSettlement(tx: Tx, workflowRunId: string) {
  const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: workflowRunId } });
  await tx.$queryRaw`SELECT "id" FROM "RenderGroup" WHERE "workflowRunId" = ${workflowRunId}::uuid ORDER BY "id" FOR UPDATE`;
  const groups = await tx.renderGroup.findMany({
    where: { workflowRunId },
    orderBy: { id: "asc" },
  });
  const snapshots = [];
  for (const group of groups) {
    const ref = { groupId: group.id, workflowRunId, workSetGeneration: group.workSetGeneration };
    const members = await memberSnapshot(tx, ref);
    const decision = deriveRenderGroupSettlement({
      members,
      chargedAttemptCount: group.chargedAttemptCount,
      databaseNow: await renderGroupDatabaseNow(tx),
    });
    // Live/expired executions must be finished by their owner or reaper first.
    if (group.status !== "running" && decision.status !== "queued")
      await tx.renderGroup.update({
        where: { id: group.id },
        data: {
          status: decision.status,
          nextAttemptAt: null,
          settledAt: group.settledAt ?? (await renderGroupDatabaseNow(tx)),
        },
      });
    snapshots.push({
      ...decision,
      status: group.status === "running" ? ("running" as const) : decision.status,
      leaseExpiresAt: group.leaseExpiresAt,
      nextAttemptAt:
        group.status === "running"
          ? null
          : decision.status === "queued"
            ? (group.nextAttemptAt ?? decision.nextAttemptAt)
            : null,
    });
  }
  const counts = snapshots.reduce(
    (sum, g) => ({
      requested: sum.requested + g.requested,
      succeeded: sum.succeeded + g.succeeded,
      failed: sum.failed + g.failed,
      superseded: sum.superseded + g.superseded,
    }),
    { requested: 0, succeeded: 0, failed: 0, superseded: 0 },
  );
  return {
    ...counts,
    ...deriveRenderParentSettlement({
      frozen: run.renderWorkSetGeneration !== null && run.renderWorkSetFrozenAt !== null,
      requestedCount: run.requestedCount ?? 0,
      groups: snapshots,
      databaseNow: await renderGroupDatabaseNow(tx),
    }),
  };
}

/** Editor persistence uses this inside its document transaction. Lock parent,
 * then groups/members, before touching mutable variant rows. */
export async function invalidateRenderGroupMembersWithinTransaction(
  tx: Tx,
  ref: RenderGroupRef,
  variantIds: readonly string[],
): Promise<number> {
  await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${ref.workflowRunId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "RenderGroup" WHERE "id" = ${ref.groupId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "clipRenderId" FROM "RenderGroupMember" WHERE "groupId" = ${ref.groupId}::uuid ORDER BY "clipRenderId" FOR UPDATE`;
  const result = await tx.renderGroupMember.updateMany({
    where: {
      groupId: ref.groupId,
      workflowRunId: ref.workflowRunId,
      workSetGeneration: ref.workSetGeneration,
      clipRenderId: { in: [...variantIds] },
      invalidatedAt: null,
    },
    data: { invalidatedAt: await renderGroupDatabaseNow(tx) },
  });
  return result.count;
}

/** Explicit cancellation takes the same parent/group/member locks as writers. */
export async function cancelRenderGroupsWithinTransaction(
  tx: Tx,
  workflowRunId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${workflowRunId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "RenderGroup" WHERE "workflowRunId" = ${workflowRunId}::uuid ORDER BY "id" FOR UPDATE`;
  const groups = await tx.renderGroup.findMany({
    where: { workflowRunId },
    orderBy: { id: "asc" },
  });
  for (const group of groups) {
    await tx.$queryRaw`SELECT "clipRenderId" FROM "RenderGroupMember" WHERE "groupId" = ${group.id}::uuid ORDER BY "clipRenderId" FOR UPDATE`;
    const now = await renderGroupDatabaseNow(tx);
    await tx.renderGroupMember.updateMany({
      where: { groupId: group.id, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    if (group.attemptToken)
      await tx.renderGroupExecution.update({
        where: { token: group.attemptToken },
        data: { finishedAt: now, result: "superseded", errorCode: "render_parent_cancelled" },
      });
    await tx.renderGroup.update({
      where: { id: group.id },
      data: {
        status: "superseded",
        attemptToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        nextAttemptAt: null,
        settledAt: now,
      },
    });
  }
}

export interface RenderGroupLifecycleDependencies {
  prisma?: PrismaClient;
  leaseOwner?: string;
  leaseDurationMs?: number;
  releaseGraceMs?: number;
}
function retryableGroupTransaction(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const detail = current as {
      code?: string;
      originalCode?: string;
      cause?: unknown;
      meta?: { modelName?: string };
    };
    if (
      ["P2034", "40001", "40P01"].includes(detail.code ?? "") ||
      ["40001", "40P01"].includes(detail.originalCode ?? "") ||
      (detail.code === "P2002" && detail.meta?.modelName === "WorkflowEvent")
    )
      return true;
    current = detail.cause;
  }
  return false;
}

export class RenderGroupLifecycle {
  private readonly prisma: PrismaClient;
  readonly leaseOwner: string;
  readonly leaseDurationMs: number;
  readonly releaseGraceMs: number;
  constructor(deps: RenderGroupLifecycleDependencies = {}) {
    const prisma = deps.prisma ?? getPrismaClient();
    if (!prisma) throw new Error("Database client unavailable");
    this.prisma = prisma;
    this.leaseOwner = deps.leaseOwner ?? randomUUID();
    this.leaseDurationMs = deps.leaseDurationMs ?? 120_000;
    this.releaseGraceMs = deps.releaseGraceMs ?? 30_000;
    if (
      !Number.isFinite(this.leaseDurationMs) ||
      this.leaseDurationMs <= 0 ||
      !Number.isFinite(this.releaseGraceMs) ||
      this.releaseGraceMs < 0
    )
      throw new Error("Invalid render group lease configuration");
  }
  private async transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const result = await operation(tx);
          await flushWorkspaceEvents(tx);
          return result;
        });
      } catch (error) {
        if (attempt >= 9 || !retryableGroupTransaction(error)) throw error;
      }
    }
  }
  private async lockParent(tx: Tx, ref: RenderGroupRef) {
    await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${ref.workflowRunId}::uuid FOR UPDATE`;
    const parent = await tx.workflowRun.findUnique({ where: { id: ref.workflowRunId } });
    return parent?.stage === "clip_rendering" &&
      ["queued", "running"].includes(parent.status) &&
      parent.renderWorkSetGeneration === ref.workSetGeneration
      ? parent
      : null;
  }
  private async owned(tx: Tx, attempt: RenderGroupAttemptRef, expired = false) {
    const parent = await this.lockParent(tx, attempt);
    await tx.$queryRaw`SELECT "id" FROM "RenderGroup" WHERE "id" = ${attempt.groupId}::uuid FOR UPDATE`;
    const group = await tx.renderGroup.findUnique({ where: { id: attempt.groupId } });
    const now = await renderGroupDatabaseNow(tx);
    if (
      !parent ||
      !group ||
      group.workflowRunId !== attempt.workflowRunId ||
      group.workSetGeneration !== attempt.workSetGeneration ||
      group.status !== "running" ||
      group.attemptToken !== attempt.token ||
      group.leaseOwner !== attempt.owner ||
      !group.leaseExpiresAt ||
      (expired ? group.leaseExpiresAt > now : group.leaseExpiresAt <= now)
    )
      throw new RenderGroupAttemptLost(attempt);
    return { parent, group, now };
  }
  async claim(
    filter: { workflowRunId?: string; groupId?: string } = {},
  ): Promise<ClaimedRenderGroupAttempt | null> {
    return this.transaction(async (tx) => {
      // Lock the parent before groups everywhere and recheck each candidate
      // after waiting so simultaneous claimers can choose distinct groups.
      const candidates = await tx.renderGroup.findMany({
        where: {
          id: filter.groupId,
          workflowRunId: filter.workflowRunId,
          status: "queued",
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: await renderGroupDatabaseNow(tx) } },
          ],
          workflowRun: { stage: "clip_rendering", status: { in: ["queued", "running"] } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 32,
      });
      for (const candidate of candidates) {
        const ref = {
          workflowRunId: candidate.workflowRunId,
          workSetGeneration: candidate.workSetGeneration,
          groupId: candidate.id,
        };
        const parent = await this.lockParent(tx, ref);
        if (
          !parent ||
          !(await tx.project.findFirst({
            where: {
              id: parent.projectId,
              ...accessibleProjectWhere(await renderGroupDatabaseNow(tx)),
              workspace: { status: "active" },
            },
            select: { id: true },
          }))
        )
          continue;
        await tx.$queryRaw`SELECT "id" FROM "RenderGroup" WHERE "id" = ${candidate.id}::uuid FOR UPDATE`;
        const group = await tx.renderGroup.findUniqueOrThrow({ where: { id: candidate.id } });
        const now = await renderGroupDatabaseNow(tx);
        if (group.status !== "queued" || (group.nextAttemptAt && group.nextAttemptAt > now))
          continue;
        const members = await memberSnapshot(tx, ref);
        const decision = deriveRenderGroupSettlement({
          members,
          chargedAttemptCount: group.chargedAttemptCount,
          databaseNow: now,
        });
        if (decision.status !== "queued") {
          await tx.renderGroup.update({
            where: { id: group.id },
            data: { status: decision.status, settledAt: now, nextAttemptAt: null },
          });
          continue;
        }
        const token = randomUUID();
        const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs);
        await tx.renderGroupExecution.create({
          data: { token, groupId: group.id, owner: this.leaseOwner, claimedAt: now },
        });
        await tx.renderGroup.update({
          where: { id: group.id },
          data: {
            status: "running",
            attemptToken: token,
            leaseOwner: this.leaseOwner,
            leaseExpiresAt,
            heartbeatAt: now,
            nextAttemptAt: null,
          },
        });
        return {
          ...ref,
          token,
          owner: this.leaseOwner,
          projectId: parent.projectId,
          clipId: group.clipId,
          exportIdentity: group.exportIdentity,
          chargedAttemptCount: group.chargedAttemptCount,
          leaseExpiresAt,
          memberIds: decision.retryVariantIds,
        };
      }
      return null;
    });
  }
  async assertOwnership(attempt: RenderGroupAttemptRef): Promise<void> {
    await this.transaction(async (tx) => {
      await this.owned(tx, attempt);
    });
  }
  async heartbeat(attempt: RenderGroupAttemptRef): Promise<void> {
    await this.transaction(async (tx) => {
      const { now } = await this.owned(tx, attempt);
      await tx.renderGroup.update({
        where: { id: attempt.groupId },
        data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs) },
      });
    });
  }
  async start(input: StartRenderGroupExecution): Promise<void> {
    if (!input.sourceFingerprint || !input.toolchainFingerprint)
      throw new Error("Missing render execution fingerprints");
    await this.transaction(async (tx) => {
      const { group, now } = await this.owned(tx, input);
      const execution = await tx.renderGroupExecution.findUniqueOrThrow({
        where: { token: input.token },
      });
      if (execution.startedAt) {
        if (
          execution.sourceFingerprint !== input.sourceFingerprint ||
          execution.analysisFingerprint !== input.analysisFingerprint ||
          execution.toolchainFingerprint !== input.toolchainFingerprint
        )
          throw new Error("Render execution fingerprints are immutable");
        return;
      }
      const charge = renderGroupChargeTransition(group.chargedAttemptCount, execution, "start");
      await tx.renderGroupExecution.update({
        where: { token: input.token },
        data: {
          startedAt: now,
          charged: charge.charged,
          sourceFingerprint: input.sourceFingerprint,
          analysisFingerprint: input.analysisFingerprint,
          toolchainFingerprint: input.toolchainFingerprint,
        },
      });
      await tx.renderGroup.update({
        where: { id: group.id },
        data: { chargedAttemptCount: charge.chargedAttemptCount },
      });
    });
  }
  private async member(tx: Tx, attempt: RenderGroupAttemptRef, id: string) {
    const owned = await this.owned(tx, attempt);
    const members = await memberSnapshot(tx, attempt);
    const member = members.find((m) => m.clipRenderId === id);
    if (!member?.variant) throw new RenderGroupAttemptLost(attempt);
    // Recheck after every potentially blocking member/variant lock.
    if (owned.group.leaseExpiresAt! <= (await renderGroupDatabaseNow(tx)))
      throw new RenderGroupAttemptLost(attempt);
    return { ...owned, variant: member.variant };
  }
  private async exportMutation(
    tx: Tx,
    exportVariantId: string | null,
    data: Prisma.ClipExportVariantUpdateManyMutationInput,
  ) {
    if (!exportVariantId) return;
    await tx.clipExportVariant.updateMany({ where: { id: exportVariantId }, data });
    await syncClipExportAggregates(tx, [exportVariantId]);
  }
  async markClipRenderVariantRendering(
    attempt: RenderGroupAttemptRef,
    id: string,
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const { variant, parent, now } = await this.member(tx, attempt, id);
      if (variant.status !== "pending") return variant.status === "rendering";
      await tx.clipRender.update({
        where: { id },
        data: {
          status: "rendering",
          workflowAttemptId: null,
          startedAt: now,
          errorCode: null,
          failureDisposition: null,
        },
      });
      await this.exportMutation(tx, variant.exportVariantId, {
        status: "rendering",
        startedAt: now,
        errorCode: null,
      });
      await appendWorkflowEvent(tx, {
        projectId: parent.projectId, workflowRunId: parent.id, attemptId: attempt.token,
        stage: "clip_rendering", status: parent.status as "queued" | "running", progress: parent.progress,
        errorCode: null, transition: `variant_started:${id}`,
      }, { redisRequired: false, analyticsEnabled: false });
      return true;
    });
  }
  async completeClipRenderVariant(
    attempt: RenderGroupAttemptRef,
    id: string,
    input: { storageKey: string; sizeBytes: number; durationSec: number },
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      // Read the durable outcome under the parent lock before testing expiry.
      // A lost commit acknowledgement must be distinguishable from rejection.
      await this.lockParent(tx, attempt);
      const existing = await tx.renderGroupVariantOutcome.findFirst({
        where: {
          token: attempt.token,
          clipRenderId: id,
          groupId: attempt.groupId,
          execution: { owner: attempt.owner },
          member: {
            workflowRunId: attempt.workflowRunId,
            workSetGeneration: attempt.workSetGeneration,
          },
        },
      });
      if (existing) {
        const render = await tx.clipRender.findUnique({ where: { id } });
        return (
          existing.groupId === attempt.groupId &&
          existing.result === "completed" &&
          render?.storageKey === input.storageKey &&
          render.sizeBytes === BigInt(input.sizeBytes) &&
          render.durationSec === input.durationSec
        );
      }
      const { variant, parent, now } = await this.member(tx, attempt, id);
      const execution = await tx.renderGroupExecution.findUniqueOrThrow({
        where: { token: attempt.token },
      });
      if (!execution.startedAt || !execution.charged)
        throw new Error("Render completion requires a durable execution start");
      if (variant.status !== "rendering") return false;
      const data = {
        status: "completed" as const,
        storageKey: input.storageKey,
        sizeBytes: BigInt(input.sizeBytes),
        durationSec: input.durationSec,
        errorCode: null,
        completedAt: now,
      };
      await tx.clipRender.update({ where: { id }, data: { ...data, failureDisposition: null } });
      await this.exportMutation(tx, variant.exportVariantId, data);
      await tx.renderGroupVariantOutcome.create({
        data: {
          token: attempt.token,
          groupId: attempt.groupId,
          clipRenderId: id,
          result: "completed",
          recordedAt: now,
        },
      });
      if (!variant.exportVariantId) await appendWorkflowEvent(tx, {
        projectId: parent.projectId, workflowRunId: parent.id, attemptId: attempt.token,
        stage: "clip_rendering", status: parent.status as "queued" | "running", progress: parent.progress,
        errorCode: null, transition: `child_completed:${id}`,
        generationRenderResults: [{ renderId: id, status: "completed", errorCode: null }],
      }, { redisRequired: isWorkflowRedisDeliveryEnabled(), analyticsEnabled: false });
      return true;
    });
  }
  /** Available after lease loss, for safe reconciliation of ambiguous commits.
   * Absence is not proof an object is unreferenced; callers retain uncertainty. */
  async readVariantOutcome(attempt: RenderGroupAttemptRef, id: string) {
    return this.prisma.renderGroupVariantOutcome.findFirst({
      where: {
        token: attempt.token,
        groupId: attempt.groupId,
        clipRenderId: id,
        execution: { owner: attempt.owner },
      },
    });
  }
  async failClipRenderVariant(
    attempt: RenderGroupAttemptRef,
    id: string,
    errorCode: string,
    disposition: "retryable" | "permanent",
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const { variant, parent, now } = await this.member(tx, attempt, id);
      const result = disposition === "retryable" ? "retryable" : "permanent";
      const existing = await tx.renderGroupVariantOutcome.findUnique({
        where: { token_clipRenderId: { token: attempt.token, clipRenderId: id } },
      });
      if (existing) return existing.result === result && existing.errorCode === errorCode;
      if (variant.status !== "rendering" && variant.status !== "pending") return false;
      await tx.clipRender.update({
        where: { id },
        data: { status: "failed", failureDisposition: disposition, errorCode, completedAt: now },
      });
      await this.exportMutation(tx, variant.exportVariantId, {
        status: disposition === "retryable" ? "rendering" : "failed",
        errorCode,
        completedAt: disposition === "permanent" ? now : null,
      });
      await tx.renderGroupVariantOutcome.create({
        data: {
          token: attempt.token,
          groupId: attempt.groupId,
          clipRenderId: id,
          result,
          errorCode,
          recordedAt: now,
        },
      });
      if (!variant.exportVariantId && disposition === "permanent") await appendWorkflowEvent(tx, {
        projectId: parent.projectId, workflowRunId: parent.id, attemptId: attempt.token,
        stage: "clip_rendering", status: parent.status as "queued" | "running", progress: parent.progress,
        errorCode: null, transition: `child_failed:${id}`,
        generationRenderResults: [{ renderId: id, status: "failed", errorCode }],
      }, { redisRequired: isWorkflowRedisDeliveryEnabled(), analyticsEnabled: false });
      return true;
    });
  }
  private async finishWithinTransaction(
    tx: Tx,
    input: FinishRenderGroupExecution,
    expired: boolean,
    release?: ReleaseRenderGroupExecution["reason"],
  ) {
    const { group, parent } = await this.owned(tx, input, expired);
    const execution = await tx.renderGroupExecution.findUniqueOrThrow({
      where: { token: input.token },
    });
    if (release === "pre_start_rejection" && execution.startedAt)
      throw new Error("A started execution requires shutdown release");
    const members = await memberSnapshot(tx, input);
    const interruptedIds = new Set(
      members
        .filter((m) => m.status === "pending" || m.status === "rendering")
        .map((m) => m.clipRenderId),
    );
    const now = await renderGroupDatabaseNow(tx);
    if (!expired && group.leaseExpiresAt! <= now) throw new RenderGroupAttemptLost(input);
    const charge = renderGroupChargeTransition(
      group.chargedAttemptCount,
      execution,
      release ? "release" : "expire",
    );
    for (const member of members) {
      if (
        member.status === "completed" ||
        member.status === "superseded" ||
        (member.status === "failed" && member.failureDisposition !== "retryable")
      )
        continue;
      if (member.status === "pending" || member.status === "rendering") {
        member.status = "failed";
        member.failureDisposition = input.failureDisposition ?? "retryable";
        await tx.clipRender.update({
          where: { id: member.clipRenderId },
          data: {
            status: "failed",
            failureDisposition: member.failureDisposition,
            errorCode: input.errorCode ?? "render_variant_interrupted",
            completedAt: now,
          },
        });
      }
    }
    const decision = deriveRenderGroupSettlement({
      members,
      chargedAttemptCount: charge.chargedAttemptCount,
      databaseNow: now,
      ...(release
        ? {
            releaseNotBefore: new Date(
              now.getTime() + (release === "shutdown" ? this.releaseGraceMs : 0),
            ),
          }
        : {}),
    });
    for (const member of members) {
      const prior = await tx.renderGroupVariantOutcome.findUnique({
        where: { token_clipRenderId: { token: input.token, clipRenderId: member.clipRenderId } },
      });
      const result =
        member.status === "superseded"
          ? "superseded"
          : member.status === "completed"
            ? "completed"
            : member.failureDisposition === "permanent"
              ? "permanent"
              : "retryable";
      if (!prior && (interruptedIds.has(member.clipRenderId) || result === "superseded"))
        await tx.renderGroupVariantOutcome.create({
          data: {
            token: input.token,
            groupId: group.id,
            clipRenderId: member.clipRenderId,
            result,
            errorCode: result === "completed" || result === "superseded" ? null : input.errorCode,
            recordedAt: now,
          },
        });
      if (!member.variant || member.status !== "failed") continue;
      const retry = decision.retryVariantIds.includes(member.clipRenderId);
      if (retry)
        await tx.clipRender.update({
          where: { id: member.clipRenderId },
          data: {
            status: "pending",
            workflowAttemptId: null,
            failureDisposition: null,
            storageKey: null,
            sizeBytes: null,
            durationSec: null,
            startedAt: null,
            completedAt: null,
            errorCode: null,
          },
        });
      await this.exportMutation(
        tx,
        member.variant.exportVariantId,
        retry
          ? {
              status: "pending",
              storageKey: null,
              sizeBytes: null,
              durationSec: null,
              errorCode: null,
              startedAt: null,
              completedAt: null,
            }
          : {
              status: "failed",
              errorCode:
                member.variant.errorCode ?? input.errorCode ?? "render_group_retries_exhausted",
              completedAt: now,
            },
      );
    }
    const causalErrorCode =
      input.errorCode ?? members.find((m) => m.status === "failed")?.variant?.errorCode ?? null;
    await tx.renderGroupExecution.update({
      where: { token: input.token },
      data: {
        finishedAt: now,
        charged: charge.charged,
        result: release
          ? "released"
          : expired
            ? "interrupted"
            : decision.status === "queued"
              ? "failed"
              : decision.status,
        errorCode: causalErrorCode,
        failureDisposition: input.failureDisposition,
      },
    });
    await tx.renderGroup.update({
      where: { id: group.id },
      data: {
        status: decision.status,
        attemptToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        nextAttemptAt: decision.nextAttemptAt,
        chargedAttemptCount: charge.chargedAttemptCount,
        settledAt: decision.status === "queued" ? null : now,
        errorCode: causalErrorCode,
        failureDisposition: input.failureDisposition,
      },
    });
    const publicResults = members.flatMap((m) =>
      m.variant &&
      !m.variant.exportVariantId &&
      (m.status === "completed" ||
        (m.status === "failed" && !decision.retryVariantIds.includes(m.clipRenderId)))
        ? [
            {
              renderId: m.clipRenderId,
              status: m.status as "completed" | "failed",
              errorCode: m.status === "completed" ? null : (m.variant.errorCode ?? input.errorCode),
            },
          ]
        : [],
    );
    await appendWorkflowEvent(
      tx,
      {
        projectId: parent.projectId,
        workflowRunId: parent.id,
        attemptId: input.token,
        stage: "clip_rendering",
        status: parent.status as "queued" | "running",
        progress: parent.progress,
        errorCode: null,
        transition: `group_finished:${input.token}`,
        ...(publicResults.length ? { generationRenderResults: publicResults } : {}),
      },
      { redisRequired: isWorkflowRedisDeliveryEnabled(), analyticsEnabled: false },
    );
    return decision;
  }
  async readExecution(attempt: RenderGroupAttemptRef) {
    return this.prisma.renderGroupExecution.findFirst({
      where: {
        token: attempt.token,
        groupId: attempt.groupId,
        owner: attempt.owner,
        group: {
          workflowRunId: attempt.workflowRunId,
          workSetGeneration: attempt.workSetGeneration,
        },
      },
    });
  }
  async finish(input: FinishRenderGroupExecution) {
    return this.transaction(async (tx) => {
      await this.lockParent(tx, input);
      const prior = await tx.renderGroupExecution.findFirst({
        where: { token: input.token, groupId: input.groupId, owner: input.owner },
      });
      if (prior?.finishedAt) return null;
      return this.finishWithinTransaction(tx, input, false);
    });
  }
  async release(input: ReleaseRenderGroupExecution): Promise<boolean> {
    return this.transaction(async (tx) => {
      await this.lockParent(tx, input);
      const prior = await tx.renderGroupExecution.findFirst({
        where: { token: input.token, groupId: input.groupId, owner: input.owner },
      });
      if (prior?.finishedAt) return prior.result === "released";
      await this.finishWithinTransaction(
        tx,
        {
          ...input,
          result: "released",
          errorCode: input.reason === "shutdown" ? "worker_shutdown" : "executor_start_rejected",
          failureDisposition: "retryable",
        },
        false,
        input.reason,
      );
      return true;
    });
  }
  async reapExpired(): Promise<number> {
    const groups = await this.prisma.renderGroup.findMany({
      where: {
        status: "running",
        leaseExpiresAt: { lte: await this.prisma.$transaction(renderGroupDatabaseNow) },
      },
      take: 100,
    });
    let reaped = 0;
    for (const group of groups) {
      if (!group.attemptToken || !group.leaseOwner) continue;
      try {
        await this.transaction((tx) =>
          this.finishWithinTransaction(
            tx,
            {
              workflowRunId: group.workflowRunId,
              workSetGeneration: group.workSetGeneration,
              groupId: group.id,
              token: group.attemptToken!,
              owner: group.leaseOwner!,
              result: "interrupted",
              errorCode: "worker_stalled",
              failureDisposition: "retryable",
            },
            true,
          ),
        );
        reaped++;
      } catch (error) {
        if (!(error instanceof RenderGroupAttemptLost)) throw error;
      }
    }
    return reaped;
  }
  /** Invalidates only the selected historical members. Editor persistence uses
   * the transaction helper above to commit invalidation with its document write. */
  async invalidateMembers(ref: RenderGroupRef, variantIds: readonly string[]): Promise<number> {
    return this.transaction((tx) =>
      invalidateRenderGroupMembersWithinTransaction(tx, ref, variantIds),
    );
  }

  /** Render evidence writes share the same parent, token and membership fence. */
  async writeLayoutEvidence(
    attempt: RenderGroupAttemptRef,
    input: {
      clipId: string;
      editorRevision: number;
      previewStorageKey: string;
      field: "automatic" | "screen" | "split";
      evidence: Prisma.InputJsonValue;
    },
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const { group } = await this.owned(tx, attempt);
      const members = await memberSnapshot(tx, attempt);
      if (
        group.clipId !== input.clipId ||
        !members.some((m) => m.variant && ["pending", "rendering"].includes(m.status))
      )
        throw new RenderGroupAttemptLost(attempt);
      if (group.leaseExpiresAt! <= (await renderGroupDatabaseNow(tx)))
        throw new RenderGroupAttemptLost(attempt);
      const written = await tx.clip.updateMany({
        where: {
          id: input.clipId,
          editorRevision: input.editorRevision,
          previewStorageKey: input.previewStorageKey,
          ...(input.field === "automatic" ? { autoLayoutAnalysis: { equals: Prisma.DbNull } } : {}),
        },
        data:
          input.field === "automatic"
            ? {
                autoLayoutAnalysis: input.evidence,
                autoLayoutStatus: "completed",
                autoLayoutClaimToken: null,
                autoLayoutLeaseExpiresAt: null,
              }
            : input.field === "screen"
              ? { layoutAnalysis: input.evidence }
              : { splitLayoutAnalysis: input.evidence },
      });
      return written.count === 1;
    });
  }
}
let singleton: RenderGroupLifecycle | undefined;
export function getRenderGroupLifecycle(): RenderGroupLifecycle {
  if (!singleton) singleton = new RenderGroupLifecycle();
  return singleton;
}
