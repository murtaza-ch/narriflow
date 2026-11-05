import { RenderGroupAttemptLost } from "./render-group-contract";
export { RenderGroupAttemptLost } from "./render-group-contract";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type ClipRender, type RenderGroup, type WorkflowRun } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import type { ClipRenderCaptionDiagnostics } from "@narriflow/validators";
import { accessibleProjectWhere } from "./project-access";
import { syncClipExportAggregates } from "./clip-export-aggregates";
import { flushWorkspaceEvents } from "./workspace-event";
import { appendWorkflowEvent } from "./workflow-event-append";
import {
  type FinishRenderGroupExecution,
  type ReleaseRenderGroupExecution,
  type RenderGroupAttemptRef,
  type RenderGroupConfiguration,
  type RenderGroupRef,
  type StartRenderGroupExecution,
  RENDER_GROUP_MAX_UNCHARGED_ATTEMPTS,
  deriveRenderGroupSettlement,
  deriveRenderParentSettlement,
  renderGroupChargeTransition,
  renderGroupExportIdentity,
  retryableTransactionFailure,
} from "./render-group-contract";

import type { ExecutionDispatchReference, ExecutionDisposition } from "@narriflow/validators/execution";
import { renderGroupOutcomeSchema, renderVariantFailureSchema, type RenderGroupOutcome, type RenderVariantFailure } from "@narriflow/validators/render-execution";
import { renderArtifactBindingHash } from "./render-artifact";
import { admitMediaCleanupObligations } from "./media-cleanup";
import { clipPreparationObjectSchema, type ClipPreparationObject } from "@narriflow/validators/clip-preparation";
import { lockPlannedExecutionObject } from "./execution-object-cleanup";
import type { NativeValidationPreparation } from "./native-validation";
import { appendExecutionDispatch, appendStableExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { admitRenderCapacityWithinTransaction, appendRenderCapacityWakesWithinTransaction } from "./render-capacity";
import { lockWorkspaceUsage } from "./processing-usage";
import { appendWorkflowRunDispatch } from "./workflow-dispatch";
import type { ExecutorArtifactCommit, ExecutorDomainLock, ExecutorMutationResult, ExecutorFailureInput, ExecutorMutationContext, ExecutorProgressInput, ExecutorReleaseInput, ExecutorExpiryObservation, ExecutorExpiryResult } from "./executor-domain-control";
import { databaseNow } from "./execution-clock";

type Tx = Prisma.TransactionClient;

export interface RenderGroupExecutionReference extends RenderGroupRef {
  projectId: string;
  generation: number;
  deploymentEpoch: number;
  attemptToken: string;
  /** Invocation-only facts freshly read under the domain locks. Never a
   * capsule or a permission that can survive this transaction. */
  work?: {
    input: ClipPreparationObject | null;
    preparationId: string | null;
    clipId: string;
    editorRevision: number;
    bindingHash: string | null;
    sourceRevision: number;
    sourceStorageKey: string | null;
    retentionExpiresAt: Date | null;
    exportIdentity: string;
    pending: Array<Pick<ClipRender, "id" | "aspectRatio" | "resolution" | "exportVariantId">>;
  };
}
export type RenderGroupArtifactCommit = ExecutorArtifactCommit & ({
  role: "render_variant";
  renderId: string;
  durationSec: number;
  captionDiagnostics?: ClipRenderCaptionDiagnostics | null;
  brollCredits?: Prisma.InputJsonValue | null;
} | {
  role: "render_outcome";
  renderId: string;
  /** Read from the sealed assigned object outside the transaction. */
  failure: RenderVariantFailure;
});
export interface RenderGroupArtifactResult {
  dispatchIds: readonly string[];
  renderGroup: RenderGroupOutcome;
}
export type RenderGroupInputPreparation = { kind: "ready"; group: RenderGroup; parent: WorkflowRun; deadlineAt: Date; deadlineDispatchId: string; dispatchIds: string[] }
  | { kind: "terminal" | "superseded"; dispatchIds: string[] } | { kind: "sleep" | "capacity_wait"; dueAt: Date; dispatchIds: string[] };

/** The column value for a render's caption diagnostics: null when nothing was left out. */
function captionDiagnosticsColumn(
  diagnostics: ClipRenderCaptionDiagnostics | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!diagnostics || diagnostics.omittedCodePoints.length + diagnostics.skippedEmoji.length === 0) return Prisma.DbNull;
  return { omittedCodePoints: [...diagnostics.omittedCodePoints], skippedEmoji: [...diagnostics.skippedEmoji] };
}
export interface RenderGroupAdmission {
  readonly configuration: RenderGroupConfiguration;
  readonly variantIds: readonly string[];
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
        deploymentEpoch: run.deploymentEpoch,
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
  return (await memberSnapshots(tx, [group])).get(group.groupId)!;
}

/** Lock and read the complete partition in batches. The coordinator owns the
 * parent lock here, so per-group round trips block child writes and heartbeats. */
type MemberSnapshot = {
  clipRenderId: string;
  status: ClipRender["status"] | "superseded";
  failureDisposition: ClipRender["failureDisposition"];
  variant: ClipRender | null;
};
async function memberSnapshots(tx: Tx, groups: readonly RenderGroupRef[]): Promise<Map<string, MemberSnapshot[]>> {
  const groupIds = groups.map((group) => group.groupId);
  if (groupIds.length === 0) return new Map();
  const ids = Prisma.join(groupIds.map((id) => Prisma.sql`${id}::uuid`));
  await tx.$queryRaw`SELECT "clipRenderId" FROM "RenderGroupMember" WHERE "groupId" IN (${ids}) ORDER BY "groupId", "clipRenderId" FOR UPDATE`;
  const members = await tx.renderGroupMember.findMany({
    where: { groupId: { in: groupIds } },
    orderBy: [{ groupId: "asc" }, { clipRenderId: "asc" }],
  });
  await tx.$queryRaw`SELECT "id" FROM "ClipRender" WHERE "id" IN (SELECT "clipRenderId" FROM "RenderGroupMember" WHERE "groupId" IN (${ids})) ORDER BY "id" FOR UPDATE`;
  const variants = await tx.clipRender.findMany({
    where: { id: { in: members.map((m) => m.clipRenderId) } },
    include: { clip: { select: { editorRevision: true } }, exportVariant: { select: { exportId: true, watermark: true } } },
  });
  const configurations = new Map((await tx.renderGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, clipId: true, exportIdentity: true } })).map(group => [group.id, group]));
  const now = await databaseNow(tx);
  const variantsById = new Map(variants.map((variant) => [variant.id, variant]));
  const groupsById = new Map(groups.map((group) => [group.groupId, group]));
  const current = (member: typeof members[number]) => {
    const variant = variantsById.get(member.clipRenderId), group = configurations.get(member.groupId);
    if (!variant || !group || variant.workflowRunId !== groupsById.get(member.groupId)!.workflowRunId || variant.clipId !== group.clipId) return false;
    const configuration: unknown = JSON.parse(group.exportIdentity);
    if (!Array.isArray(configuration) || configuration.length !== 5) throw new Error("Invalid frozen render group configuration");
    return variant.resolution === configuration[3] && (variant.editorRevision ?? variant.clip.editorRevision) === configuration[2] &&
      (variant.exportVariant?.exportId ?? null) === configuration[1] && (!variant.exportVariant || variant.exportVariant.watermark === configuration[4]);
  };
  const newlySuperseded = members.filter((member) => {
    return !member.invalidatedAt && !current(member);
  });
  if (newlySuperseded.length > 0)
    await tx.renderGroupMember.updateMany({
      where: {
        OR: newlySuperseded.map(({ groupId, clipRenderId }) => ({ groupId, clipRenderId })),
        invalidatedAt: null,
      },
      data: { invalidatedAt: now },
    });
  return new Map(groups.map((group) => [group.groupId,
    members.filter((member) => member.groupId === group.groupId).map((m) => {
      const variant = variantsById.get(m.clipRenderId);
      const superseded =
        m.invalidatedAt !== null || !current(m);
      return {
        clipRenderId: m.clipRenderId,
        status: superseded ? ("superseded" as const) : variant!.status,
        failureDisposition: variant?.failureDisposition ?? null,
        variant: superseded ? null : variant!,
      };
    }),
  ] as const));
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
  const membersByGroup = await memberSnapshots(tx, groups.map((group) => ({
    groupId: group.id, workflowRunId, workSetGeneration: group.workSetGeneration,
  })));
  const now = await databaseNow(tx);
  const snapshots = [];
  for (const group of groups) {
    const members = membersByGroup.get(group.id)!;
    const decision = deriveRenderGroupSettlement({
      members,
      chargedAttemptCount: group.chargedAttemptCount,
      databaseNow: now,
    });
    // Live/expired executions must be finished by their owner or reaper first.
    if (group.status !== "running" && decision.status !== "queued" &&
      (group.status !== decision.status || group.nextAttemptAt !== null || group.settledAt === null))
      await tx.renderGroup.update({
        where: { id: group.id },
        data: {
          status: decision.status,
          nextAttemptAt: null,
          settledAt: group.settledAt ?? now,
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
      databaseNow: await databaseNow(tx),
    }),
  };
}

/** Cancelled renders never reach their owner again, so their export variants
 * and aggregates settle in the same commit. A retryable failure has no retry left. */
export async function failUnfinishedRendersWithinTransaction(tx: Tx, where: Prisma.ClipRenderWhereInput, errorCode: string, now: Date): Promise<void> {
  const renders = await tx.clipRender.findMany({ where: { AND: [where, { OR: [{ status: { in: ["pending", "rendering"] } }, { status: "failed", failureDisposition: "retryable" }] }] },
    orderBy: { id: "asc" }, select: { id: true, exportVariantId: true } });
  if (!renders.length) return;
  await tx.clipRender.updateMany({ where: { id: { in: renders.map(render => render.id) } }, data: { status: "failed", errorCode, failureDisposition: "permanent", completedAt: now } });
  const variantIds = renders.flatMap(render => render.exportVariantId ? [render.exportVariantId] : []);
  await tx.clipExportVariant.updateMany({ where: { id: { in: variantIds }, status: { not: "completed" } }, data: { status: "failed", errorCode, completedAt: now } });
  await syncClipExportAggregates(tx, variantIds);
}

/** Explicit cancellation takes the same parent/group/member locks as writers. */
export async function cancelRenderGroupsWithinTransaction(
  tx: Tx,
  workflowRunId: string,
  errorCode = "render_parent_cancelled",
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${workflowRunId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "RenderGroup" WHERE "workflowRunId" = ${workflowRunId}::uuid ORDER BY "id" FOR UPDATE`;
  const groups = await tx.renderGroup.findMany({
    where: { workflowRunId },
    orderBy: { id: "asc" },
  });
  for (const group of groups) {
    await tx.$queryRaw`SELECT "clipRenderId" FROM "RenderGroupMember" WHERE "groupId" = ${group.id}::uuid ORDER BY "clipRenderId" FOR UPDATE`;
    const now = await databaseNow(tx);
    await tx.renderGroupMember.updateMany({
      where: { groupId: group.id, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    if (group.attemptToken)
      await tx.renderGroupExecution.update({
        where: { token: group.attemptToken },
        data: { finishedAt: now, result: "superseded", errorCode },
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
  await failUnfinishedRendersWithinTransaction(tx, { workflowRunId }, errorCode, await databaseNow(tx));
}

/** One parent wake per group outcome. The group's own Workflow never waits on it. */
async function groupOutcomeWake(groupId: string, generation: number, retry: boolean): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([groupId, generation, retry])));
  return `group_${Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export interface RenderGroupLifecycleDependencies {
  prisma?: PrismaClient;
  /** Groups that may hold a deadline at once. Omitted only by tests that do not exercise admission. */
  maxAdmittedGroups?: number;
}
export class RenderGroupLifecycle {
  private readonly prisma: PrismaClient;
  private readonly maxAdmittedGroups: number | undefined;
  private readonly releaseGraceMs = 30_000;
  constructor(deps: RenderGroupLifecycleDependencies = {}) {
    const prisma = deps.prisma ?? getPrismaClient();
    if (!prisma) throw new Error("Database client unavailable");
    this.prisma = prisma;
    this.maxAdmittedGroups = deps.maxAdmittedGroups;
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
        if (attempt >= 9 || !retryableTransactionFailure(error)) throw error;
      }
    }
  }
  private async lockParent(tx: Tx, ref: RenderGroupRef, mode: "shared" | "exclusive" = "shared") {
    if (mode === "exclusive") await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${ref.workflowRunId}::uuid FOR UPDATE`;
    else await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${ref.workflowRunId}::uuid FOR SHARE`;
    const parent = await tx.workflowRun.findUnique({ where: { id: ref.workflowRunId } });
    return parent?.stage === "clip_rendering" &&
      ["queued", "running", "waiting"].includes(parent.status) &&
      parent.renderWorkSetGeneration === ref.workSetGeneration
      ? parent
      : null;
  }
  private async owned(tx: Tx, attempt: RenderGroupAttemptRef, expired = false) {
    const parent = await this.lockParent(tx, attempt);
    await tx.$queryRaw`SELECT "id" FROM "RenderGroup" WHERE "id" = ${attempt.groupId}::uuid FOR UPDATE`;
    const group = await tx.renderGroup.findUnique({ where: { id: attempt.groupId } });
    const now = await databaseNow(tx);
    if (
      !parent ||
      !group ||
      group.workflowRunId !== attempt.workflowRunId ||
      group.workSetGeneration !== attempt.workSetGeneration ||
      group.status !== "running" ||
      group.attemptToken !== attempt.token ||
      group.leaseOwner !== attempt.owner ||
      !group.leaseExpiresAt ||
      (!expired && group.operationDeadlineAt !== null && group.operationDeadlineAt <= now) ||
      (expired ? group.leaseExpiresAt > now : group.leaseExpiresAt <= now)
    )
      throw new RenderGroupAttemptLost(attempt);
    return { parent, group, now };
  }
  /** Root executor control holds the epoch lock before entering this domain. */
  private async executionState(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string): Promise<
    { kind: "current"; ref: RenderGroupExecutionReference; group: RenderGroup; parent: WorkflowRun; parentLockMode: "shared" | "exclusive"; now: Date; clip: { id: string; editorRevision: number } | null; clipExists: boolean; members: MemberSnapshot[] } |
    { kind: "terminal"; disposition: ExecutionDisposition }
  > {
    if (reference.subject.kind !== "render_group") return { kind: "terminal", disposition: { disposition: "superseded" } };
    const initial = await tx.renderGroup.findUnique({ where: { id: reference.subject.id }, include: {
      workflowRun: { include: { project: { select: { workspaceId: true, sourceRevision: true } } } },
      preparation: { select: { projectId: true, clipId: true, deploymentEpoch: true, sourceRevision: true } },
    } });
    if (!initial) return { kind: "terminal", disposition: { disposition: "superseded" } };
    // Child commands mutate their own group, not their shared parent or usage.
    // A known stale source still takes the exclusive batch-cancellation fence.
    const staleSource = initial.preparation && (initial.preparation.projectId !== initial.workflowRun.projectId ||
      initial.preparation.clipId !== initial.clipId || initial.preparation.deploymentEpoch !== initial.deploymentEpoch ||
      initial.preparation.sourceRevision !== initial.workflowRun.project.sourceRevision);
    const parentLockMode = staleSource ? "exclusive" as const : "shared" as const;
    await lockWorkspaceUsage(tx, initial.workflowRun.project.workspaceId, "shared");
    if (staleSource) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${initial.workflowRun.projectId}, 0)) IS NULL AS "locked"`;
    else await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${initial.workflowRun.projectId}, 0)) IS NULL AS "locked"`;
    const groupRef = { groupId: initial.id, workflowRunId: initial.workflowRunId, workSetGeneration: initial.workSetGeneration };
    const parent = await this.lockParent(tx, groupRef, parentLockMode);
    await tx.$queryRaw`SELECT "id" FROM "RenderGroup" WHERE "id" = ${initial.id}::uuid FOR UPDATE`;
    const group = await tx.renderGroup.findUnique({ where: { id: initial.id } });
    if (!parent || !group || group.deploymentEpoch !== reference.deploymentEpoch || parent.deploymentEpoch !== reference.deploymentEpoch ||
      group.generation !== reference.generation || group.workSetGeneration !== groupRef.workSetGeneration || group.workflowRunId !== parent.id) {
      return { kind: "terminal", disposition: { disposition: "superseded" } };
    }
    if (["completed", "partial"].includes(group.status)) return { kind: "terminal", disposition: { disposition: "completed" } };
    if (group.status === "superseded") return { kind: "terminal", disposition: { disposition: "superseded" } };
    if (group.status === "failed") return { kind: "terminal", disposition: { disposition: "failed", failureCode: "render_group_failed" } };
    if (group.status === "running" && group.attemptToken !== attemptToken) return { kind: "terminal", disposition: { disposition: "superseded" } };
    const clips = await tx.$queryRaw<Array<{ id: string; editorRevision: number }>>`SELECT id, "editorRevision" FROM "Clip" WHERE id = ${group.clipId}::uuid AND "projectId" = ${parent.projectId}::uuid FOR SHARE`;
    const members = await memberSnapshot(tx, groupRef);
    const now = await databaseNow(tx);
    return { kind: "current", clip: clips[0] ?? null, clipExists: clips.length === 1, ref: { ...groupRef, projectId: parent.projectId, generation: group.generation, deploymentEpoch: group.deploymentEpoch, attemptToken }, group, parent, parentLockMode, now, members };
  }

  async lockExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string): Promise<ExecutorDomainLock<RenderGroupExecutionReference>> {
    const state = await this.executionState(tx, reference, attemptToken);
    if (state.kind === "terminal") return { ...state, dispatchIds: await this.recordedExecutionWakes(tx, reference) };
    if (!state.clipExists) {
      // Historical preparation and charged execution rows survive Clip replacement.
      // Only this group's publication permission ends; other Clips keep their owners.
      const { group, now } = state;
      await tx.renderGroupMember.updateMany({ where: { groupId: group.id, invalidatedAt: null }, data: { invalidatedAt: now } });
      if (group.attemptToken) {
        await tx.renderGroupExecution.updateMany({ where: { groupId: group.id, token: group.attemptToken, finishedAt: null },
          data: { finishedAt: now, result: "interrupted", errorCode: "render_clip_deleted" } });
      }
      await tx.renderGroup.update({ where: { id: group.id }, data: { status: "superseded", attemptToken: null, leaseOwner: null,
        leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null, settledAt: now } });
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${attemptToken}::uuid FOR UPDATE`;
      await tx.executionAttempt.updateMany({ where: { attemptToken, dispatchId: reference.dispatchId, generation: reference.generation,
        deploymentEpoch: reference.deploymentEpoch, inputHash: reference.inputHash, status: { in: ["admitted", "running"] } },
        data: { status: "superseded", revokedAt: now, finishedAt: now, failureCode: "render_clip_deleted" } });
      return { kind: "terminal", disposition: { disposition: "superseded" }, ...(await this.executionWakes(tx, state.ref, reference.inputHash, false)) };
    }
    const project = await tx.project.findFirst({ where: { id: state.ref.projectId, ...accessibleProjectWhere(state.now) }, select: { id: true, sourceRevision: true, sourceStorageKey: true, expiresAt: true, workspace: { select: { status: true } } } });
    if (project && project.workspace.status !== "active") return { kind: "terminal", disposition: { disposition: "cancelled" }, restricted: true };
    const preparation = state.group.preparationId ? await tx.clipPreparation.findUnique({ where: { id: state.group.preparationId }, select: { sourceRevision: true, projectId: true, clipId: true, deploymentEpoch: true, bindingHash: true } }) : null;
    if (project && preparation && (preparation.sourceRevision !== project.sourceRevision || preparation.projectId !== project.id || preparation.clipId !== state.group.clipId || preparation.deploymentEpoch !== state.group.deploymentEpoch)) {
      // A source change can win before the shared Project fence is acquired.
      // Refuse it without upgrading a parent lock beneath sibling readers.
      // The existing watchdog rechecks the stale source with the batch fence.
      if (state.parentLockMode !== "exclusive") return { kind: "terminal", disposition: { disposition: "superseded" }, dispatchIds: await this.recordedExecutionWakes(tx, reference) };
      await cancelRenderGroupsWithinTransaction(tx, state.parent.id);
      return { kind: "terminal", disposition: { disposition: "superseded" }, ...(await this.executionWakes(tx, state.ref, reference.inputHash, false)) };
    }
    const group = state.group;
    return project ? { kind: "current", ref: { ...state.ref, work: {
      input: group.inputStorageKey && group.inputEtag && group.inputByteLength && group.inputChecksumSha256
        ? { storageKey: group.inputStorageKey, etag: group.inputEtag, byteLength: Number(group.inputByteLength), sha256: group.inputChecksumSha256 } : null,
      preparationId: group.preparationId, clipId: group.clipId, editorRevision: state.clip!.editorRevision, bindingHash: preparation?.bindingHash ?? null,
      sourceRevision: project.sourceRevision, sourceStorageKey: project.sourceStorageKey, retentionExpiresAt: project.expiresAt, exportIdentity: group.exportIdentity,
      pending: state.members.flatMap(member => member.variant && ["pending", "rendering"].includes(member.status)
        ? [{ id: member.variant.id, aspectRatio: member.variant.aspectRatio, resolution: member.variant.resolution, exportVariantId: member.variant.exportVariantId }] : []),
    } } } : { kind: "terminal", disposition: { disposition: "cancelled" } };
  }

  private executionAttempt(ref: RenderGroupExecutionReference, context: ExecutorMutationContext): RenderGroupAttemptRef {
    if (ref.groupId !== context.reference.subject.id || context.reference.subject.kind !== "render_group" ||
      ref.generation !== context.reference.generation || ref.deploymentEpoch !== context.reference.deploymentEpoch ||
      ref.attemptToken !== context.attemptToken || context.functionName !== "render_group") {
      throw new RenderGroupAttemptLost({ ...ref, token: context.attemptToken, owner: context.owner });
    }
    return { workflowRunId: ref.workflowRunId, workSetGeneration: ref.workSetGeneration, groupId: ref.groupId, token: context.attemptToken, owner: context.owner };
  }

  async acquireExecution(tx: Tx, ref: RenderGroupExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const attempt = this.executionAttempt(ref, context);
    const parent = await this.lockParent(tx, ref);
    await tx.$queryRaw`SELECT "id" FROM "RenderGroup" WHERE "id" = ${ref.groupId}::uuid FOR UPDATE`;
    const group = await tx.renderGroup.findUniqueOrThrow({ where: { id: ref.groupId } });
    const now = await databaseNow(tx);
    const source = parent ? await tx.project.findUnique({ where: { id: parent.projectId }, select: { ingestStatus: true, sourceStorageKey: true, sourceRevision: true } }) : null;
    const preparation = group.preparationId ? await tx.clipPreparation.findUnique({ where: { id: group.preparationId } }) : null;
    const admitted = await tx.executionAttempt.findUnique({ where: { attemptToken: context.attemptToken } });
    if (!parent || source?.ingestStatus !== "ready" || !source.sourceStorageKey || group.generation !== ref.generation || group.deploymentEpoch !== ref.deploymentEpoch ||
      preparation?.status !== "completed" || preparation.projectId !== parent.projectId || preparation.clipId !== group.clipId || preparation.sourceRevision !== source.sourceRevision ||
      !group.inputStorageKey || !group.inputEtag || !group.inputByteLength || !group.inputChecksumSha256 || !admitted ||
      admitted.inputStorageKey !== group.inputStorageKey || admitted.inputEtag !== group.inputEtag || admitted.inputByteLength !== group.inputByteLength || admitted.inputChecksumSha256 !== group.inputChecksumSha256 ||
      group.status !== "queued" || (group.nextAttemptAt && group.nextAttemptAt > now) ||
      context.leaseExpiresAt <= now || context.leaseExpiresAt > context.operationDeadlineAt || context.operationDeadlineAt <= now ||
      (group.operationDeadlineAt && group.operationDeadlineAt.getTime() !== context.operationDeadlineAt.getTime())) throw new RenderGroupAttemptLost(attempt);
    const members = await memberSnapshot(tx, ref);
    const decision = deriveRenderGroupSettlement({ members, chargedAttemptCount: group.chargedAttemptCount, databaseNow: await databaseNow(tx) });
    if (decision.status !== "queued" || !decision.retryVariantIds.length) throw new RenderGroupAttemptLost(attempt);
    await tx.renderGroupExecution.create({ data: { token: attempt.token, groupId: group.id, owner: attempt.owner, claimedAt: now } });
    await tx.renderGroup.update({ where: { id: group.id }, data: { status: "running", attemptToken: attempt.token, leaseOwner: attempt.owner,
      leaseExpiresAt: context.leaseExpiresAt, heartbeatAt: now, nextAttemptAt: null, operationDeadlineAt: context.operationDeadlineAt } });
    const watchdog = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "render_group", id: ref.groupId },
      generation: ref.generation, inputHash: context.reference.inputHash, dueAt: context.operationDeadlineAt, deadlineKind: "operation", observedDeadlineAt: context.operationDeadlineAt });
    const acquired = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "render_group", id: ref.groupId },
      generation: ref.generation, inputHash: context.reference.inputHash, dueAt: now, wakeKind: "execution_acquired", deadlineKind: "lease", observedDeadlineAt: context.leaseExpiresAt });
    return { dispatchIds: [watchdog.reference.dispatchId, acquired.reference.dispatchId] };
  }

  async renewExecution(tx: Tx, ref: RenderGroupExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const attempt = this.executionAttempt(ref, context);
    const { group, now } = await this.owned(tx, attempt);
    if (!group.operationDeadlineAt || group.operationDeadlineAt.getTime() !== context.operationDeadlineAt.getTime() ||
      context.leaseExpiresAt <= now || context.leaseExpiresAt > group.operationDeadlineAt) throw new RenderGroupAttemptLost(attempt);
    await tx.renderGroup.update({ where: { id: group.id }, data: { heartbeatAt: now, leaseExpiresAt: context.leaseExpiresAt } });
    return undefined;
  }

  async startExecution(tx: Tx, ref: RenderGroupExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const attempt = this.executionAttempt(ref, context);
    if (!context.fingerprints) throw new Error("Expected frozen render provenance is unavailable");
    await this.startWithinTransaction(tx, { ...attempt, sourceFingerprint: context.fingerprints.source,
      analysisFingerprint: context.fingerprints.analysis, toolchainFingerprint: context.fingerprints.toolchain });
    const members = await memberSnapshot(tx, ref);
    for (const member of members) if (member.status === "pending") await this.markClipRenderVariantRenderingWithinTransaction(tx, attempt, member.clipRenderId);
    return undefined;
  }

  private async executionWakes(tx: Tx, ref: RenderGroupExecutionReference, inputHash: string, retry: boolean): Promise<{ dispatchIds: string[] }> {
    const current = await tx.renderGroup.update({ where: { id: ref.groupId }, data: retry ? { generation: { increment: 1 } } : {} });
    const now = await databaseNow(tx);
    const finished = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "render_group", id: ref.groupId },
      generation: ref.generation, inputHash: inputHash, dueAt: now, wakeKind: "execution_finished" });
    const parent = await appendWorkflowRunDispatch(tx, ref.workflowRunId);
    const parentWake = await appendExecutionDispatch(tx, { ...parent.reference, dueAt: now, wakeKind: await groupOutcomeWake(current.id, current.generation, retry) });
    const ids = [finished.reference.dispatchId, parentWake.reference.dispatchId];
    if (!retry && this.maxAdmittedGroups !== undefined) ids.push(...await appendRenderCapacityWakesWithinTransaction(tx, {
      releasedGroupId: ref.groupId, deploymentEpoch: ref.deploymentEpoch, maxAdmittedGroups: this.maxAdmittedGroups }));
    if (retry) {
      const queued = await appendExecutionDispatch(tx, { deploymentEpoch: current.deploymentEpoch, kind: "operation_driver", subject: { kind: "render_group", id: current.id },
        generation: current.generation, inputHash: inputHash, dueAt: current.nextAttemptAt ?? now });
      ids.push(queued.reference.dispatchId);
    }
    return { dispatchIds: ids };
  }

  private async recordedExecutionWakes(tx: Tx, reference: ExecutionDispatchReference): Promise<string[]> {
    const finished = await tx.executionDispatch.findFirst({ where: { deploymentEpoch: reference.deploymentEpoch, generation: reference.generation,
      inputHash: reference.inputHash, subjectKind: "render_group", subjectId: reference.subject.id, kind: "operation_driver", wakeKind: "execution_finished" }, select: { id: true } });
    if (!finished) return [];
    const group = await tx.renderGroup.findUnique({ where: { id: reference.subject.id }, select: { workflowRunId: true } });
    const parent = group ? await tx.executionDispatch.findFirst({ where: { deploymentEpoch: reference.deploymentEpoch, kind: "render_run", subjectKind: "workflow_run", subjectId: group.workflowRunId,
      wakeKind: await groupOutcomeWake(reference.subject.id, reference.generation, false) }, select: { id: true } }) : null;
    return [finished.id, ...(parent ? [parent.id] : [])];
  }

  private async prepareInputWithinTransaction(tx: Tx, reference: ExecutionDispatchReference): Promise<RenderGroupInputPreparation> {
    const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT epoch FROM "ExecutionEpoch" WHERE id=1 FOR SHARE`;
    const registered = await readExecutionDispatch(tx, reference.dispatchId);
    if (!epoch || reference.kind !== "operation_driver" || reference.subject.kind !== "render_group" || reference.deploymentEpoch !== epoch.epoch ||
      !registered || JSON.stringify(registered.reference) !== JSON.stringify(reference)) return { kind: "superseded", dispatchIds: [] };
    const initial = await tx.renderGroup.findUnique({ where: { id: reference.subject.id } });
    const state = await this.executionState(tx, reference, initial?.attemptToken ?? reference.dispatchId);
    if (state.kind === "terminal") return { kind: state.disposition.disposition === "superseded" ? "superseded" : "terminal", dispatchIds: await this.recordedExecutionWakes(tx, reference) };
    const { parent, now, ref } = state;
    let { group } = state;
    const project = await tx.project.findFirst({ where: { id: parent.projectId, ...accessibleProjectWhere(now), workspace: { status: "active" } }, select: { id: true, workspaceId: true, workspace: { select: { pricingTier: true } } } });
    if (!project) return { kind: "superseded", dispatchIds: [] };
    if (!group.operationDeadlineAt && group.status === "queued" && this.maxAdmittedGroups !== undefined) {
      const unsettled = deriveRenderGroupSettlement({ members: await memberSnapshot(tx, ref), chargedAttemptCount: group.chargedAttemptCount, databaseNow: now }).status === "queued";
      const slot = unsettled ? await admitRenderCapacityWithinTransaction(tx, { group, workspaceId: project.workspaceId, tier: project.workspace.pricingTier, maxAdmittedGroups: this.maxAdmittedGroups }) : null;
      if (slot && !slot.admitted) {
        // Only the group's own driver keeps the timer. Any other wake has done its job.
        return registered.wakeKind ? { kind: "superseded", dispatchIds: [] } : { kind: "capacity_wait", dueAt: slot.retryAt, dispatchIds: [] };
      }
      if (slot?.admitted && group.capacityWaitSince) {
        console.warn(JSON.stringify({ level: "info", message: "render_capacity_admitted", groupId: group.id, waitedMs: slot.waitedMs }));
        group = { ...group, capacityWaitSince: null, nextAttemptAt: null };
      }
    }
    // The clock starts at admission, so time spent waiting for a slot cannot fail the group.
    const deadlineAt = group.operationDeadlineAt ?? new Date((await databaseNow(tx)).getTime()+45*60_000);
    if (!group.operationDeadlineAt) await tx.renderGroup.update({ where: { id: group.id }, data: { operationDeadlineAt: deadlineAt } });
    const watchdog = await appendExecutionDispatch(tx, { deploymentEpoch: group.deploymentEpoch, generation: group.generation, kind: "operation_driver", subject: reference.subject,
      inputHash: reference.inputHash, dueAt: deadlineAt, deadlineKind: "operation", observedDeadlineAt: deadlineAt });
    const dispatchIds = [watchdog.reference.dispatchId];
    if (group.status === "queued" && deadlineAt <= now) {
      const expired = await this.expireQueuedExecution(tx, state, reference, reference.dispatchId);
      return { kind: "terminal", dispatchIds: [...dispatchIds, ...("dispatchIds" in expired ? expired.dispatchIds ?? [] : [])] };
    }
    if (group.status === "queued") {
      const members = await memberSnapshot(tx, ref), decision = deriveRenderGroupSettlement({ members, chargedAttemptCount: group.chargedAttemptCount, databaseNow: now });
      if (decision.status !== "queued") {
        await tx.renderGroup.update({ where: { id: group.id }, data: { status: decision.status, nextAttemptAt: null, settledAt: now } });
        return { kind: "terminal", dispatchIds: [...dispatchIds, ...(await this.executionWakes(tx, ref, reference.inputHash, false)).dispatchIds] };
      }
      if (group.nextAttemptAt && group.nextAttemptAt > now) return { kind: "sleep", dueAt: group.nextAttemptAt, dispatchIds };
    }
    return { kind: "ready", group: { ...group, operationDeadlineAt: deadlineAt }, parent, deadlineAt, deadlineDispatchId: watchdog.reference.dispatchId, dispatchIds };
  }

  /** The watchdog commits before any private input PUT or provider metadata I/O. */
  async prepareInputDeadline(reference: ExecutionDispatchReference): Promise<RenderGroupInputPreparation> {
    return this.transaction(tx => this.prepareInputWithinTransaction(tx, reference));
  }

  async planInputWrite(reference: ExecutionDispatchReference, preparationId: string): Promise<string> {
    return this.transaction(async tx => {
      const state = await this.prepareInputWithinTransaction(tx, reference);
      if (state.kind !== "ready" || state.group.status !== "queued" || state.group.attemptToken || state.group.preparationId !== preparationId) throw new Error("render_input_unavailable");
      const key = `projects/${state.parent.projectId}/render-groups/${state.group.id}/${randomUUID()}.json`;
      await admitMediaCleanupObligations(tx, [{ origin: "clip_preparation_input", cleanupClass: "execution_input", projectId: state.parent.projectId,
        clipId: state.group.clipId, objectKey: key, notBefore: new Date(state.deadlineAt.getTime()+120_000) }]);
      return key;
    });
  }

  async adoptInput(reference: ExecutionDispatchReference, preparationId: string, input: ClipPreparationObject): Promise<ClipPreparationObject> {
    const parsed = clipPreparationObjectSchema.safeParse(input);
    if (!parsed.success || parsed.data.byteLength > 16_777_216) throw new Error("render_input_invalid");
    input = parsed.data;
    return this.transaction(async tx => {
      const state = await this.prepareInputWithinTransaction(tx, reference);
      if (state.kind !== "ready" || state.group.status !== "queued" || state.group.attemptToken || state.group.preparationId !== preparationId) throw new Error("render_input_unavailable");
      const prepared = await tx.clipPreparation.findUnique({ where: { id: preparationId } });
      if (prepared?.status !== "completed" || prepared.projectId !== state.parent.projectId || prepared.clipId !== state.group.clipId || prepared.deploymentEpoch !== state.group.deploymentEpoch) throw new Error("render_input_unavailable");
      const prefix = `projects/${state.parent.projectId}/render-groups/${state.group.id}/`;
      if (!input.storageKey.startsWith(prefix) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(input.storageKey.slice(prefix.length))) throw new Error("render_input_invalid");
      if (!state.group.inputStorageKey) await lockPlannedExecutionObject(tx, { origin: "clip_preparation_input", storageKey: input.storageKey });
      const current = state.group.inputStorageKey ? state.group : await tx.renderGroup.update({ where: { id: state.group.id }, data: {
        inputStorageKey: input.storageKey, inputEtag: input.etag, inputByteLength: BigInt(input.byteLength), inputChecksumSha256: input.sha256 } });
      return { storageKey: current.inputStorageKey!, etag: current.inputEtag!, byteLength: Number(current.inputByteLength!), sha256: current.inputChecksumSha256! };
    });
  }

  async admitPreparedExecution(reference: ExecutionDispatchReference): Promise<NativeValidationPreparation> {
    return this.transaction(async tx => {
      const state = await this.prepareInputWithinTransaction(tx, reference);
      if (state.kind !== "ready") return state;
      const { group, deadlineAt } = state;
      const preparation = group.preparationId ? await tx.clipPreparation.findUnique({ where: { id: group.preparationId } }) : null;
      if (preparation?.status !== "completed" || !group.inputStorageKey || !group.inputEtag || !group.inputByteLength || !group.inputChecksumSha256) throw new Error("render_input_unavailable");
      const identity = { deploymentEpoch: group.deploymentEpoch, generation: group.generation, kind: "modal_execution" as const, subject: reference.subject };
      const native = await appendStableExecutionDispatch(tx, { ...identity, inputHash: reference.inputHash, dueAt: group.nextAttemptAt ?? group.createdAt });
      const attempts = await tx.executionAttempt.findMany({ where: { dispatchId: native.reference.dispatchId }, take: 2 });
      if (attempts.length > 1) throw new Error("render_input_unavailable");
      const attempt = attempts[0] ?? await tx.executionAttempt.create({ data: { attemptToken: randomUUID(), dispatchId: native.reference.dispatchId,
        deploymentEpoch: group.deploymentEpoch, generation: group.generation, inputHash: reference.inputHash, functionName: "render_group", operationDeadlineAt: deadlineAt,
        inputStorageKey: group.inputStorageKey, inputEtag: group.inputEtag, inputByteLength: group.inputByteLength, inputChecksumSha256: group.inputChecksumSha256 } });
      if (attempt.functionName !== "render_group" || attempt.operationDeadlineAt.getTime() !== deadlineAt.getTime() || attempt.inputStorageKey !== group.inputStorageKey || attempt.inputEtag !== group.inputEtag ||
        attempt.inputByteLength !== group.inputByteLength || attempt.inputChecksumSha256 !== group.inputChecksumSha256 || group.status === "running" && attempt.attemptToken !== group.attemptToken) throw new Error("render_input_unavailable");
      const until = group.leaseExpiresAt ?? deadlineAt, kind = group.leaseExpiresAt ? "lease" as const : "operation" as const;
      const watchdog = await appendExecutionDispatch(tx, { deploymentEpoch: group.deploymentEpoch, generation: group.generation, kind: "operation_driver", subject: reference.subject,
        inputHash: reference.inputHash, dueAt: until, deadlineKind: kind, observedDeadlineAt: until });
      return { kind: "waiting", deadline: { reference: native.reference, attemptToken: attempt.attemptToken, kind, observedDeadlineAt: until.toISOString() },
        deliveryId: watchdog.reference.dispatchId, dispatchIds: [...new Set([...state.dispatchIds, watchdog.reference.dispatchId, native.reference.dispatchId])] };
    });
  }

  async failPreparation(reference: ExecutionDispatchReference, preparationId: string): Promise<readonly string[]> {
    return this.transaction(async tx => {
      const state = await this.prepareInputWithinTransaction(tx, reference);
      if (state.kind !== "ready") return state.dispatchIds;
      const preparation = await tx.clipPreparation.findUnique({ where: { id: preparationId } });
      if (state.group.status !== "queued" || state.group.attemptToken || state.group.preparationId !== preparationId || !preparation || !["failed", "superseded"].includes(preparation.status)) throw new Error("render_input_unavailable");
      const result = await this.expireQueuedExecution(tx, { ...state, ref: { groupId: state.group.id, workflowRunId: state.parent.id, workSetGeneration: state.group.workSetGeneration,
        projectId: state.parent.projectId, generation: state.group.generation, deploymentEpoch: state.group.deploymentEpoch, attemptToken: reference.dispatchId } }, reference, reference.dispatchId, "clip_preparation_failed");
      return [...state.dispatchIds, ...("dispatchIds" in result ? result.dispatchIds ?? [] : [])];
    });
  }

  async commitArtifactExecution(tx: Tx, ref: RenderGroupExecutionReference, context: ExecutorMutationContext, artifact: RenderGroupArtifactCommit): Promise<RenderGroupArtifactResult | undefined> {
    const attempt = this.executionAttempt(ref, context);
    if (!["render_variant", "render_outcome"].includes(artifact.role) || !Number.isSafeInteger(Number(artifact.byteLength)) || artifact.byteLength <= 0n ||
      artifact.bindingHash !== await renderArtifactBindingHash({ inputHash: context.reference.inputHash, renderId: artifact.renderId, role: artifact.role })) throw new Error("Invalid prepared render artifact");
    let accepted: boolean;
    if (artifact.role === "render_outcome") {
      const parsed = renderVariantFailureSchema.safeParse(artifact.failure);
      if (artifact.contentType !== "application/json" || artifact.byteLength > 65536n || !parsed.success ||
        parsed.data.renderId !== artifact.renderId || parsed.data.bindingHash !== artifact.bindingHash) throw new Error("Invalid prepared render artifact");
      accepted = await this.failClipRenderVariantWithinTransaction(tx, attempt, artifact.renderId, parsed.data.errorCode, parsed.data.disposition);
    } else {
      if (artifact.contentType !== "video/mp4" || !Number.isFinite(artifact.durationSec) || artifact.durationSec <= 0) throw new Error("Invalid prepared render artifact");
      accepted = await this.completeClipRenderVariantWithinTransaction(tx, attempt, artifact.renderId, { storageKey: artifact.storageKey, sizeBytes: Number(artifact.byteLength), durationSec: artifact.durationSec, captionDiagnostics: artifact.captionDiagnostics, brollCredits: artifact.brollCredits });
    }
    if (!accepted) {
      throw new RenderGroupAttemptLost(attempt);
    }
    const members = await memberSnapshot(tx, ref);
    if (members.some((member) => member.status === "pending" || member.status === "rendering")) return;
    const failed = members.find(member => member.status === "failed");
    const decision = await this.finishWithinTransaction(tx, { ...attempt, result: failed ? "failed" : "completed", errorCode: failed?.variant?.errorCode ?? null, failureDisposition: failed?.failureDisposition ?? null }, false);
    const { status, requested, succeeded, failed: failedCount, superseded } = decision;
    const renderGroup = renderGroupOutcomeSchema.parse({ status, requested, succeeded, failed: failedCount, superseded });
    return { ...await this.executionWakes(tx, ref, context.reference.inputHash, decision.status === "queued"), renderGroup };
  }

  async failExecution(tx: Tx, ref: RenderGroupExecutionReference, context: ExecutorMutationContext, failure: ExecutorFailureInput): Promise<ExecutorMutationResult> {
    const attempt = this.executionAttempt(ref, context);
    const decision = await this.finishWithinTransaction(tx, { ...attempt, result: "failed", errorCode: failure.failureCode, failureDisposition: failure.retryable ? "retryable" : "permanent" }, false);
    return this.executionWakes(tx, ref, context.reference.inputHash, decision.status === "queued");
  }

  async releaseExecution(tx: Tx, ref: RenderGroupExecutionReference, context: ExecutorMutationContext, release: ExecutorReleaseInput): Promise<ExecutorMutationResult> {
    const attempt = this.executionAttempt(ref, context);
    await this.releaseWithinTransaction(tx, { ...attempt, reason: release.reason === "startup_rejected" ? "pre_start_rejection" : "shutdown" });
    const group = await tx.renderGroup.findUniqueOrThrow({ where: { id: ref.groupId } });
    return this.executionWakes(tx, ref, context.reference.inputHash, group.status === "queued");
  }

  async progressExecution(tx: Tx, ref: RenderGroupExecutionReference, context: ExecutorMutationContext, _progress: ExecutorProgressInput): Promise<ExecutorMutationResult> {
    // Public render progress is derived from committed member outcomes.
    await this.owned(tx, this.executionAttempt(ref, context));
    return undefined;
  }

  /** The same unstarted transition serves pre-input and admitted-native deadlines. */
  private async expireQueuedExecution(tx: Tx, state: { group: RenderGroup; parent: WorkflowRun; ref: RenderGroupExecutionReference }, reference: ExecutionDispatchReference, eventId: string, failureCode = "operation_deadline_exceeded"): Promise<ExecutorExpiryResult> {
    const { group, parent, ref } = state;
    const members = await memberSnapshot(tx, ref);
    const clock = await databaseNow(tx);
    const failures: Array<{ renderId: string; status: "failed"; errorCode: string }> = [];
    for (const member of members) {
      if (!member.variant || member.status === "completed" || member.status === "superseded" ||
        (member.status === "failed" && member.failureDisposition === "permanent")) continue;
      await tx.clipRender.update({ where: { id: member.clipRenderId }, data: { status: "failed", failureDisposition: "permanent", errorCode: failureCode, completedAt: clock } });
      await this.exportMutation(tx, member.variant.exportVariantId, { status: "failed", errorCode: failureCode, completedAt: clock });
      member.status = "failed"; member.failureDisposition = "permanent";
      if (!member.variant.exportVariantId) failures.push({ renderId: member.clipRenderId, status: "failed", errorCode: failureCode });
    }
    const decision = deriveRenderGroupSettlement({ members, chargedAttemptCount: group.chargedAttemptCount, databaseNow: clock });
    if (decision.status === "queued") throw new Error("Expired render group still has unsettled members");
    await tx.renderGroup.update({ where: { id: group.id }, data: { status: decision.status, nextAttemptAt: null, settledAt: clock, errorCode: failureCode, failureDisposition: "permanent" } });
    await appendWorkflowEvent(tx, { projectId: ref.projectId, workflowRunId: parent.id, attemptId: eventId, stage: "clip_rendering", status: parent.status as "queued" | "running" | "waiting",
      progress: parent.progress, errorCode: null, transition: `unstarted_group_failed:${eventId}:${failureCode}`, ...(failures.length ? { generationRenderResults: failures } : {}) });
    return { kind: "expired", ...await this.executionWakes(tx, ref, reference.inputHash, false) };
  }

  /** A preparation deadline owns no native token, lease, charge or process history. */
  async expirePreparationDeadline(reference: ExecutionDispatchReference, observation: ExecutorExpiryObservation): Promise<ExecutorExpiryResult | { kind: "native"; attemptToken: string }> {
    return this.transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT epoch FROM "ExecutionEpoch" WHERE id = 1 FOR SHARE`;
      const dispatch = await readExecutionDispatch(tx, reference.dispatchId);
      if (!epoch || reference.deploymentEpoch !== epoch.epoch || reference.kind !== "operation_driver" || reference.subject.kind !== "render_group" || observation.kind !== "operation" ||
        !dispatch || JSON.stringify(dispatch.reference) !== JSON.stringify(reference) || dispatch.deadlineKind !== "operation" ||
        dispatch.observedDeadlineAt?.getTime() !== observation.observedDeadlineAt.getTime()) return { kind: "superseded" };
      const initial = await tx.renderGroup.findUnique({ where: { id: reference.subject.id } });
      const state = await this.executionState(tx, reference, initial?.attemptToken ?? reference.dispatchId);
      if (state.kind === "terminal") return { kind: state.disposition.disposition === "superseded" ? "superseded" : "terminal", dispatchIds: await this.recordedExecutionWakes(tx, reference) };
      if (!state.group.operationDeadlineAt || state.group.operationDeadlineAt.getTime() !== observation.observedDeadlineAt.getTime()) return { kind: "superseded" };
      if (state.group.status === "running") return state.group.attemptToken && state.group.leaseOwner && state.group.leaseExpiresAt
        ? { kind: "native", attemptToken: state.group.attemptToken } : { kind: "superseded" };
      if (state.group.status !== "queued" || state.group.attemptToken || state.group.leaseOwner || state.group.leaseExpiresAt) return { kind: "superseded" };
      if (state.group.operationDeadlineAt > state.now) return { kind: "sleep", dueAt: state.group.operationDeadlineAt };
      return this.expireQueuedExecution(tx, state, reference, reference.dispatchId);
    });
  }

  async expireExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string, observation: ExecutorExpiryObservation): Promise<ExecutorExpiryResult> {
    if (!["lease", "operation"].includes(observation.kind) || !Number.isFinite(observation.observedDeadlineAt.getTime())) throw new Error("Invalid execution deadline observation");
    const state = await this.executionState(tx, reference, attemptToken);
    if (state.kind === "terminal") return { kind: state.disposition.disposition === "superseded" ? "superseded" : "terminal" };
    const { group, ref, now } = state;
    const admitted = await tx.executionAttempt.findFirst({ where: { attemptToken, deploymentEpoch: reference.deploymentEpoch, generation: reference.generation, inputHash: reference.inputHash,
      dispatch: { id: reference.dispatchId, kind: reference.kind, subjectKind: "render_group", subjectId: ref.groupId } } });
    if (!admitted || (group.operationDeadlineAt && group.operationDeadlineAt.getTime() !== admitted.operationDeadlineAt.getTime())) return { kind: "superseded" };
    if (observation.kind === "operation" && observation.observedDeadlineAt.getTime() !== admitted.operationDeadlineAt.getTime()) return { kind: "superseded" };
    const absolute = admitted.operationDeadlineAt;
    if (group.status === "queued") {
      if (absolute > now) return { kind: "sleep", dueAt: absolute };
      return this.expireQueuedExecution(tx, state, reference, attemptToken);
    }
    if (group.attemptToken !== attemptToken || !group.leaseOwner || !group.leaseExpiresAt) return { kind: "terminal" };
    const deadline = new Date(Math.min(group.leaseExpiresAt.getTime(), absolute.getTime()));
    if (deadline > now) return { kind: "sleep", dueAt: deadline };
    const expiredOperation = absolute <= now;
    const attempt = { ...ref, token: attemptToken, owner: group.leaseOwner };
    const decision = await this.finishWithinTransaction(tx, { ...attempt, result: "interrupted", errorCode: expiredOperation ? "operation_deadline_exceeded" : "worker_stalled", failureDisposition: expiredOperation ? "permanent" : "retryable" }, true);
    return { kind: "expired", ...await this.executionWakes(tx, ref, reference.inputHash, decision.status === "queued") };
  }
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async startWithinTransaction(tx: Tx, input: StartRenderGroupExecution): Promise<void> {
    if (!input.sourceFingerprint || !input.toolchainFingerprint)
      throw new Error("Missing render execution fingerprints");

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
  }
  private async member(tx: Tx, attempt: RenderGroupAttemptRef, id: string) {
    const owned = await this.owned(tx, attempt);
    const members = await memberSnapshot(tx, attempt);
    const member = members.find((m) => m.clipRenderId === id);
    if (!member?.variant) throw new RenderGroupAttemptLost(attempt);
    // Recheck after every potentially blocking member/variant lock.
    if (owned.group.leaseExpiresAt! <= (await databaseNow(tx)))
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
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async markClipRenderVariantRenderingWithinTransaction(tx: Tx, 
    attempt: RenderGroupAttemptRef,
    id: string,
  ): Promise<boolean> {


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
      stage: "clip_rendering", status: parent.status as "queued" | "running" | "waiting", progress: parent.progress,
      errorCode: null, transition: `variant_started:${id}`,
    });
    return true;
  }
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async completeClipRenderVariantWithinTransaction(tx: Tx, 
    attempt: RenderGroupAttemptRef,
    id: string,
    input: {
      storageKey: string;
      sizeBytes: number;
      durationSec: number;
      /** Caption characters the render left out; absent or empty clears it. */
      captionDiagnostics?: ClipRenderCaptionDiagnostics | null;
      brollCredits?: Prisma.InputJsonValue | null;
    },
  ): Promise<boolean> {


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
    await tx.clipRender.update({
      where: { id },
      data: { ...data, failureDisposition: null, captionDiagnostics: captionDiagnosticsColumn(input.captionDiagnostics), brollCredits: input.brollCredits ?? Prisma.DbNull },
    });
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
      stage: "clip_rendering", status: parent.status as "queued" | "running" | "waiting", progress: parent.progress,
      errorCode: null, transition: `child_completed:${id}`,
      generationRenderResults: [{ renderId: id, status: "completed", errorCode: null }],
    });
    return true;
  }
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async failClipRenderVariantWithinTransaction(tx: Tx, 
    attempt: RenderGroupAttemptRef,
    id: string,
    errorCode: string,
    disposition: "retryable" | "permanent",
  ): Promise<boolean> {


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
      stage: "clip_rendering", status: parent.status as "queued" | "running" | "waiting", progress: parent.progress,
      errorCode: null, transition: `child_failed:${id}`,
      generationRenderResults: [{ renderId: id, status: "failed", errorCode }],
    });
    return true;
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
    const now = await databaseNow(tx);
    if (!expired && group.leaseExpiresAt! <= now) throw new RenderGroupAttemptLost(input);
    const charge = renderGroupChargeTransition(
      group.chargedAttemptCount,
      execution,
      release ? "release" : "expire",
    );
    const unchargedAttemptCount = charge.charged ? 0 :
      1 + await tx.renderGroupExecution.count({ where: { groupId: group.id, charged: false, finishedAt: { not: null } } });
    // Permanent members settle the group, here and in every later parent read.
    const failureDisposition = unchargedAttemptCount >= RENDER_GROUP_MAX_UNCHARGED_ATTEMPTS ? "permanent" : input.failureDisposition;
    for (const member of members) {
      if (
        member.status === "completed" ||
        member.status === "superseded" ||
        (member.status === "failed" && member.failureDisposition !== "retryable")
      )
        continue;
      if (member.status === "pending" || member.status === "rendering") {
        member.status = "failed";
        member.failureDisposition = failureDisposition ?? "retryable";
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
      unchargedAttemptCount,
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
        failureDisposition,
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
        failureDisposition,
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
        status: parent.status as "queued" | "running" | "waiting",
        progress: parent.progress,
        errorCode: null,
        transition: `group_finished:${input.token}`,
        ...(publicResults.length ? { generationRenderResults: publicResults } : {}),
      },
    );
    return decision;
  }
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async releaseWithinTransaction(tx: Tx, input: ReleaseRenderGroupExecution): Promise<boolean> {


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
  }
}
