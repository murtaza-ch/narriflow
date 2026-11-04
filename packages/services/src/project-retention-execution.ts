import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { readExecutionAdmission } from "./execution-admission";
import { executeExecutionPage, readExecutionPageReceipt } from "./execution-page-receipt";
import { lockExecutionRecoveryParents } from "./execution-recovery-locks";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { queueMediaCleanupBatchWithinTransaction } from "./media-cleanup-control";
import { queueExportsFinishedByRun, queueIngestJobFinished } from "./operation-finished";
import { flushWorkspaceEvents } from "./workspace-event";
import { flushProjectProgressDrains } from "./progress-outbox";
import { collectExecutionDispatch, takeExecutionDispatchIds } from "./execution-dispatch-runtime";
import { USER_DELETED_RETENTION_POLICY } from "./project-retention.service";
import { appendClipSelectionCapacityWake } from "./clip-selection-window";
import { appendScribeCapacityWakesWithinTransaction } from "./transcription-admission";
import type { MaintenancePhaseHandler } from "./execution-maintenance";
import { hasUnresolvedProviderOutcome } from "./project-provider-outcome";
type Tx = Prisma.TransactionClient;
type Position = { id: string; at: Date };
const phases = [
  "permissions",
  "ingest",
  "workflows",
  "groups",
  "selection",
  "artifacts",
  "plans",
  "references",
  "await",
] as const;
type Phase = (typeof phases)[number];
const hash = (epoch: number, id: string) =>
  createHash("sha256")
    .update(JSON.stringify(["project-retention-page-v1", epoch, id]))
    .digest("hex");
const receiptKey = (projectId: string) =>
  `retention-receipts/v1/${createHash("sha256").update(projectId).digest("hex")}.json`;
function identity(projectId: string, at: Date, passAt: Date, phase: Phase, after: Position | null) {
  return `pr1.${projectId}.${at.getTime()}.${passAt.getTime()}.${phase}${after ? `.${after.at.getTime()}.${after.id.replaceAll("-", "")}` : ""}`;
}
function parse(id: string) {
  const m =
    /^pr1\.([a-f0-9-]{36})\.(0|[1-9][0-9]{0,12})\.(0|[1-9][0-9]{0,12})\.([a-z_]+)(?:\.(0|[1-9][0-9]{0,12})\.([a-f0-9]{32}))?$/.exec(
      id,
    );
  if (!m || !phases.includes(m[4] as Phase)) throw Error("project_retention_reference_invalid");
  const idHex = m[6],
    after = idHex
      ? {
          at: new Date(Number(m[5])),
          id: `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-${idHex.slice(12, 16)}-${idHex.slice(16, 20)}-${idHex.slice(20)}`,
        }
      : null;
  return { projectId: m[1]!, at: new Date(Number(m[2])), passAt: new Date(Number(m[3])), phase: m[4] as Phase, after };
}
async function append(
  tx: Tx,
  epoch: number,
  projectId: string,
  at: Date,
  passAt: Date,
  phase: Phase,
  after: Position | null,
  wakeKind?: string,
  dueAt = at,
) {
  const id = identity(projectId, at, passAt, phase, after);
  return (
    await appendExecutionDispatch(tx, {
      kind: "maintenance",
      subject: { kind: "maintenance", id },
      generation: 1,
      deploymentEpoch: epoch,
      inputHash: hash(epoch, id),
      dueAt,
      wakeKind,
    })
  ).reference;
}
export interface ProjectDeletionProof {
  version: 1;
  countBasis: "acknowledged_exact_keys";
  byteBasis: "known_committed_bytes";
  projectIdHash: string;
  retentionPolicyKey: string;
  expiresAt: string;
  purgeCompletedAt: string;
  objectCount: number;
  totalBytes: string;
  deleteAfter: string;
}
export interface ProjectRetentionExecutionDependencies {
  database: PrismaClient;
  register(ids: readonly string[]): Promise<void>;
  writeDeletionReceipt(key: string, proof: ProjectDeletionProof): Promise<void>;
  releaseUsage(tx: Tx, projectId: string): Promise<void>;
}
/** A cleanup completion resolves its waiting Project by authoritative row. No
 * executor can choose a parent Workflow ID or deletion namespace. */
export async function appendProjectPurgeWake(tx: Tx, projectId: string, cause: string, at: Date) {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { purgeStartedAt: true } });
  if (!project?.purgeStartedAt) return [];
  const { epoch } = await readExecutionAdmission(tx);
  return [
    (
      await append(
        tx,
        epoch,
        projectId,
        project.purgeStartedAt,
        at,
        "await",
        null,
        `clean_${cause.replaceAll("-", "")}`,
        at,
      )
    ).dispatchId,
  ];
}
/** A user's delete enters the same durable purge as an expired Project, so the
 * storage inventory and the row delete have one path. The caller holds the parent
 * locks and has refused live work; the hourly planner re-drives a lost dispatch. */
export async function beginUserProjectPurge(tx: Tx, projectId: string, epoch: number) {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  const at = clock!.now;
  await tx.project.update({
    where: { id: projectId },
    data: {
      retentionPolicyKey: USER_DELETED_RETENTION_POLICY,
      expiresAt: at,
      purgeStartedAt: at,
      purgeAttemptCount: { increment: 1 },
      purgeLeaseExpiresAt: null,
      purgeRetryAt: null,
    },
  });
  collectExecutionDispatch(tx, (await append(tx, epoch, projectId, at, at, "permissions", null)).dispatchId);
}
export const planProjectRetentionPage: MaintenancePhaseHandler = async (tx, page) => {
  const before = new Date(page.cutoff.getTime() - 60000),
    after = page.after
      ? Prisma.sql`AND ("expiresAt",id)>((${page.after.at}::timestamp),${page.after.id}::uuid)`
      : Prisma.empty;
  const rows = await tx.$queryRaw<
      Array<Position & { workspaceId: string; projectId: string }>
    >`SELECT id,id AS "projectId","expiresAt" AS at,"workspaceId" FROM "Project" WHERE "expiresAt"<=(${before}::timestamp) AND "retentionPolicyKey" IS NOT NULL ${after} ORDER BY "expiresAt",id LIMIT ${page.limit + 1}`,
    selected = rows.slice(0, page.limit);
  await lockExecutionRecoveryParents(tx, selected);
  const dispatchIds: string[] = [];
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  for (const row of selected) {
    const project = await tx.project.findUniqueOrThrow({ where: { id: row.id } });
    if (!project.expiresAt || project.expiresAt > before) continue;
    const at = project.purgeStartedAt ?? clock!.now;
    if (!project.purgeStartedAt)
      await tx.project.update({
        where: { id: project.id },
        data: {
          purgeStartedAt: at,
          purgeAttemptCount: { increment: 1 },
          purgeLeaseExpiresAt: null,
          purgeRetryAt: null,
        },
      });
    dispatchIds.push(
      (await append(tx, page.deploymentEpoch, project.id, at, page.cutoff, "permissions", null)).dispatchId,
    );
  }
  return { processed: selected.length, next: rows.length > page.limit ? selected.at(-1)! : null, dispatchIds };
};
/** All identifiers are fixed local model names. SQL enumerates the Project's
 * accepted ledgers/keys; it never lists a bucket or infers an unknown orphan. */
function projectSubjects(projectId: string) {
  return Prisma.sql`project_subjects AS (
 SELECT 'ingest_job'::text AS kind,id FROM "IngestJob" WHERE "projectId"=${projectId}::uuid
 UNION ALL SELECT 'workflow_run',id FROM "WorkflowRun" WHERE "projectId"=${projectId}::uuid
 UNION ALL SELECT 'render_group',g.id FROM "RenderGroup" g JOIN "WorkflowRun" r ON r.id=g."workflowRunId" WHERE r."projectId"=${projectId}::uuid
 UNION ALL SELECT 'clip_preparation',id FROM "ClipPreparation" WHERE "projectId"=${projectId}::uuid
 UNION ALL SELECT 'clip_selection_window',id FROM "ClipSelectionWindow" WHERE "projectId"=${projectId}::uuid
 UNION ALL SELECT 'generated_media',id FROM "GeneratedMediaJob" WHERE "projectId"=${projectId}::uuid
 UNION ALL SELECT 'thumbnail_frame',id FROM "ThumbnailFrameOperation" WHERE "projectId"=${projectId}::uuid
 UNION ALL SELECT 'dubbing',id FROM "ClipDub" WHERE "projectId"=${projectId}::uuid
 UNION ALL SELECT 'social_publication',id FROM "SocialPost" WHERE "projectId"=${projectId}::uuid
 UNION ALL SELECT 'export_bundle',b.id FROM "ExportBundle" b JOIN "CampaignOperation" e ON e.id=b."operationId" WHERE e."projectId"=${projectId}::uuid)`;
}
const after = (point: Position | null, alias: string, key = "id") =>
  point
    ? Prisma.sql`AND (${Prisma.raw(`${alias}."createdAt"`)},${Prisma.raw(`${alias}."${key}"`)})>((${point.at}::timestamp),${point.id}::uuid)`
    : Prisma.empty;
/** Objects no executor attempt owns: the raw provider transcript, and an upload
 * whether or not it was ever pinned to an execution artifact. */
async function unassignedObjects(tx: Tx, projectId: string) {
  const project = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { sourceStorageKey: true, transcript: { select: { rawStorageKey: true } } },
    }),
    upload = await tx.uploadSession.findUnique({
      where: { preallocatedProjectId: projectId },
      select: { storageKey: true },
    });
  const source =
    project.sourceStorageKey &&
    !(await tx.executionArtifact.findUnique({ where: { storageKey: project.sourceStorageKey }, select: { id: true } }))
      ? project.sourceStorageKey
      : null;
  return [
    ...[source, upload?.storageKey].flatMap((key) =>
      key
        ? [{ origin: "project_retention" as const, cleanupClass: "upload_source" as const, projectId, objectKey: key }]
        : [],
    ),
    ...(project.transcript?.rawStorageKey
      ? [
          {
            origin: "project_retention" as const,
            cleanupClass: "transcript_raw" as const,
            projectId,
            objectKey: project.transcript.rawStorageKey,
          },
        ]
      : []),
  ];
}
async function pageWork(tx: Tx, epoch: number, page: ReturnType<typeof parse>) {
  const { projectId, phase } = page,
    limit = 32;
  let rows: Position[] = [],
    dispatchIds: string[] = [];
  if (phase === "permissions") {
    rows = await tx.$queryRaw<Position[]>(
      Prisma.sql`WITH ${projectSubjects(projectId)} SELECT a."attemptToken" AS id,a."createdAt" AS at FROM project_subjects s JOIN "ExecutionDispatch" d ON d."subjectKind"=s.kind AND d."subjectId"=s.id::text JOIN "ExecutionAttempt" a ON a."dispatchId"=d.id WHERE a.status IN ('admitted','running') ${after(page.after, "a", "attemptToken")} ORDER BY a."createdAt",a."attemptToken" LIMIT ${limit + 1}`,
    );
    await tx.executionAttempt.updateMany({
      where: {
        attemptToken: { in: rows.slice(0, limit).map((row) => row.id) },
        status: { in: ["admitted", "running"] },
      },
      data: { status: "cancelled", revokedAt: page.at, finishedAt: page.at, failureCode: "PROJECT_EXPIRED" },
    });
  } else if (["ingest", "workflows", "selection", "groups"].includes(phase)) {
    const table =
        phase === "ingest"
          ? "IngestJob"
          : phase === "workflows"
            ? "WorkflowRun"
            : phase === "selection"
              ? "ClipSelectionWindow"
              : "RenderGroup",
      join = phase === "groups" ? Prisma.sql`JOIN "WorkflowRun" r ON r.id=x."workflowRunId"` : Prisma.empty,
      project = phase === "groups" ? Prisma.sql`r."projectId"` : Prisma.sql`x."projectId"`,
      statuses =
        phase === "workflows"
          ? Prisma.sql`x.status IN ('queued','running','waiting')`
          : Prisma.sql`x.status IN ('queued','running')`;
    rows = await tx.$queryRaw<Position[]>(
      Prisma.sql`SELECT x.id,x."createdAt" AS at FROM ${Prisma.raw(`"${table}"`)} x ${join} WHERE ${project}=${projectId}::uuid AND ${statuses} ${after(page.after, "x")} ORDER BY x."createdAt",x.id LIMIT ${limit + 1}`,
    );
    const ids = rows.slice(0, limit).map((row) => row.id);
    if (phase === "ingest") {
      await tx.ingestJob.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "cancelled",
          lastError: "PROJECT_EXPIRED",
          completedAt: page.at,
          claimId: null,
          executorOwner: null,
          claimExpiresAt: null,
          sourceCredential: null,
        },
      });
      for (const id of ids) await queueIngestJobFinished(tx, id, "cancelled");
    }
    if (phase === "workflows") {
      await tx.workflowRun.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "cancelled",
          errorCode: "PROJECT_EXPIRED",
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          nextAttemptAt: null,
          nextPollAt: null,
          waitingSince: null,
        },
      });
      for (const id of ids) await queueExportsFinishedByRun(tx, id);
      if (ids.length)
        dispatchIds.push(
          ...(await appendScribeCapacityWakesWithinTransaction(tx, { deploymentEpoch: epoch, attemptId: ids[0]! }))
            .dispatchIds,
        );
    }
    if (phase === "groups") {
      await tx.renderGroupExecution.updateMany({
        where: { groupId: { in: ids }, finishedAt: null },
        data: { finishedAt: page.at, result: "superseded", errorCode: "PROJECT_EXPIRED" },
      });
      await tx.renderGroup.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "superseded",
          attemptToken: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          errorCode: "PROJECT_EXPIRED",
          settledAt: page.at,
        },
      });
    }
    if (phase === "selection") {
      await tx.clipSelectionWindow.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "cancelled",
          executorOwner: null,
          leaseExpiresAt: null,
          errorCode: "PROJECT_EXPIRED",
          completedAt: page.at,
        },
      });
      if (ids.length) dispatchIds.push(...(await appendClipSelectionCapacityWake(tx, epoch, ids[0]!, page.at)));
    }
  } else if (phase === "artifacts") {
    if (
      (await hasUnresolvedProviderOutcome(tx, projectId)) ||
      (await tx.socialPost.findFirst({
        where: { projectId, status: { in: ["publishing", "processing", "reconciling", "needs_attention"] } },
        select: { id: true },
      }))
    )
      throw Error("project_retention_provider_outcome_unresolved");

    const artifacts = await tx.$queryRaw<
      Array<Position & { storageKey: string; drain: Date }>
    >(Prisma.sql`WITH ${projectSubjects(projectId)} SELECT art.id,art."createdAt" AS at,art."storageKey",GREATEST(art."grantExpiresAt",a."operationDeadlineAt")+INTERVAL '120 seconds' AS drain
      FROM project_subjects s JOIN "ExecutionDispatch" d ON d."subjectKind"=s.kind AND d."subjectId"=s.id::text
      JOIN "ExecutionAttempt" a ON a."dispatchId"=d.id JOIN "ExecutionArtifact" art ON art."attemptToken"=a."attemptToken"
      WHERE TRUE
   AND NOT EXISTS(SELECT 1 FROM "VisualAsset" v WHERE v."storageKey"=art."storageKey" AND v."deletedAt" IS NULL) AND NOT EXISTS(SELECT 1 FROM "BrandFont" f WHERE f."storageKey"=art."storageKey") ${after(page.after, "art")} ORDER BY art."createdAt",art.id LIMIT ${limit + 1}`);
    rows = artifacts;
    await admitMediaCleanupObligations(
      tx,
      artifacts
        .slice(0, limit)
        .map((row) => ({
          origin: "project_retention" as const,
          cleanupClass: "assigned_artifact" as const,
          projectId,
          objectKey: row.storageKey,
          notBefore: row.drain,
        })),
    );
    if (!page.after) await admitMediaCleanupObligations(tx, await unassignedObjects(tx, projectId));
  } else if (phase === "plans") {
    rows = await tx.$queryRaw<Position[]>(
      Prisma.sql`SELECT m.id,m."createdAt" AS at FROM "MediaCleanupObligation" m WHERE m."projectId"=${projectId}::uuid AND m."completedAt" IS NULL AND NOT EXISTS(SELECT 1 FROM "VisualAsset" v WHERE v."storageKey"=m."objectKey" AND v."deletedAt" IS NULL) ${after(page.after, "m")} ORDER BY m."createdAt",m.id LIMIT ${limit + 1}`,
    );
    dispatchIds = (
      await queueMediaCleanupBatchWithinTransaction(
        tx,
        rows.slice(0, limit).map((row) => row.id),
      )
    ).map((ref) => ref.dispatchId);
  } else if (phase === "references") {
    const [missing] = await tx.$queryRaw<
      Array<{ key: string }>
    >`WITH refs AS (SELECT "sourceStorageKey" AS key FROM "Project"
      WHERE id=${projectId}::uuid UNION ALL SELECT "rawStorageKey" FROM "Transcript"
      WHERE "projectId"=${projectId}::uuid UNION ALL SELECT "storageKey"
      FROM "SourceAudio" WHERE "projectId"=${projectId}::uuid UNION ALL SELECT b."storageKey"
      FROM "ExportBundle" b JOIN "CampaignOperation" e ON e.id=b."operationId"
      WHERE e."projectId"=${projectId}::uuid UNION ALL SELECT "previewStorageKey"
      FROM "Clip" WHERE "projectId"=${projectId}::uuid UNION ALL SELECT r."storageKey"
      FROM "ClipRender" r JOIN "Clip" c ON c.id=r."clipId" WHERE c."projectId"=${projectId}::uuid
      UNION ALL SELECT "audioStorageKey" FROM "ClipDub" WHERE "projectId"=${projectId}::uuid
      UNION ALL SELECT "renderStorageKey" FROM "ClipDub" WHERE "projectId"=${projectId}::uuid)
   SELECT key FROM refs WHERE key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "MediaCleanupObligation" m WHERE m."objectKey"=refs.key AND m."projectId"=${projectId}::uuid) AND NOT EXISTS(SELECT 1 FROM "VisualAsset" v WHERE v."storageKey"=refs.key AND v."deletedAt" IS NULL) LIMIT 1`;
    if (missing) throw Error("project_retention_key_provenance_missing");
  }
  await flushWorkspaceEvents(tx);
  dispatchIds.push(...(await flushProjectProgressDrains(tx)), ...takeExecutionDispatchIds(tx));
  const selected = rows.slice(0, limit);
  return { processed: Math.max(1, selected.length), next: rows.length > limit ? selected.at(-1)! : null, dispatchIds };
}
export function createProjectRetentionExecution(options: ProjectRetentionExecutionDependencies) {
  async function state(tx: Tx, ref: ExecutionDispatchReference) {
    const current = await readExecutionAdmission(tx),
      ledger = await readExecutionDispatch(tx, ref.dispatchId);
    if (
      !ledger ||
      JSON.stringify(ledger.reference) !== JSON.stringify(ref) ||
      ref.kind !== "maintenance" ||
      ref.subject.kind !== "maintenance" ||
      ref.generation !== 1 ||
      hash(ref.deploymentEpoch, ref.subject.id) !== ref.inputHash
    )
      throw Error("project_retention_reference_invalid");
    const page = parse(ref.subject.id);
    if (current.epoch !== ref.deploymentEpoch) return null;
    const project = await tx.project.findUnique({ where: { id: page.projectId } });
    if (!project) return { page, project: null };
    if (project.purgeStartedAt?.getTime() !== page.at.getTime() || !project.expiresAt || !project.retentionPolicyKey)
      throw Error("project_retention_fence_invalid");
    await lockExecutionRecoveryParents(tx, [{ workspaceId: project.workspaceId, projectId: project.id }]);
    return { page, project };
  }
  return {
    async run(value: ExecutionDispatchReference): Promise<{ kind: "complete" } | { kind: "sleep"; dueAt: Date }> {
      const ref = executionDispatchReferenceSchema.parse(value),
        initial = await options.database.$transaction(async (tx) => {
          const value = await state(tx, ref);
          if (!value) return null;
          return { ...value, receipt: await readExecutionPageReceipt(tx, ref, "maintenance-page") };
        });
      if (!initial) return { kind: "complete" };
      if (initial.receipt) {
        await options.register(initial.receipt.dispatchIds);
        return { kind: "complete" };
      }
      if (!initial.project) return { kind: "complete" };
      if (initial.page.phase !== "await") {
        const result = await options.database.$transaction(async (tx) => {
          const value = await state(tx, ref);
          if (!value?.project) return { dispatchIds: [] };
          return executeExecutionPage(tx, ref, "maintenance-page", async () => {
            const work = await pageWork(tx, ref.deploymentEpoch, value.page),
              phase = work.next ? value.page.phase : phases[phases.indexOf(value.page.phase) + 1]!;
            const continuation = await append(
              tx,
              ref.deploymentEpoch,
              value.project!.id,
              value.page.at,
              value.page.passAt,
              phase,
              work.next,
            );
            return {
              kind: "continue",
              processed: work.processed,
              dispatchIds: [...new Set([...work.dispatchIds, continuation.dispatchId])],
            };
          });
        });
        await options.register(result.dispatchIds);
        return { kind: "complete" };
      }
      const ready = await options.database.$transaction(async (tx) => {
        const value = await state(tx, ref);
        if (!value?.project) return null;
        const [pending] = await tx.$queryRaw<
          Array<{ nextAttemptAt: Date; claimExpiresAt: Date | null }>
        >`SELECT m."nextAttemptAt",m."claimExpiresAt" FROM "MediaCleanupObligation" m WHERE m."projectId"=${value.project.id}::uuid AND m."completedAt" IS NULL AND NOT EXISTS(SELECT 1 FROM "VisualAsset" v WHERE v."storageKey"=m."objectKey" AND v."deletedAt" IS NULL) ORDER BY m."nextAttemptAt",m.id LIMIT 1`;
        if (pending)
          return {
            kind: "sleep" as const,
            dueAt: pending.claimExpiresAt ?? pending.nextAttemptAt,
            now: (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`)[0]!.now,
          };
        const blocked = await tx.socialPost.findFirst({
          where: {
            projectId: value.project.id,
            status: { in: ["publishing", "processing", "reconciling", "needs_attention"] },
          },
          select: { id: true },
        });
        if (blocked) throw Error("project_retention_provider_outcome_unresolved");
        const [rows] = await tx.$queryRaw<
          Array<{ count: number; bytes: bigint }>
        >`SELECT COUNT(*)::integer AS count,COALESCE(SUM(found."byteLength"),0)::bigint AS bytes
          FROM (SELECT DISTINCT ON(m."objectKey") m."objectKey",art."byteLength"
          FROM "MediaCleanupObligation" m LEFT JOIN "ExecutionArtifact" art ON art."storageKey"=m."objectKey"
          WHERE m."projectId"=${value.project.id}::uuid AND m."completedAt" IS NOT NULL AND NOT EXISTS(SELECT 1
          FROM "VisualAsset" v WHERE v."storageKey"=m."objectKey" AND v."deletedAt" IS NULL)
          ORDER BY m."objectKey") found`;
        const now =
          value.project.purgeStorageVerifiedAt ??
          (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`)[0]!.now;
        if (!value.project.purgeStorageVerifiedAt)
          await tx.project.update({
            where: { id: value.project.id },
            data: { purgeStorageVerifiedAt: now, purgeDeletedObjectCount: rows!.count, purgeDeletedBytes: rows!.bytes },
          });
        return {
          kind: "ready" as const,
          project: value.project,
          proof: {
            version: 1 as const,
            countBasis: "acknowledged_exact_keys" as const,
            byteBasis: "known_committed_bytes" as const,
            projectIdHash: createHash("sha256").update(value.project.id).digest("hex"),
            retentionPolicyKey: value.project.retentionPolicyKey!,
            expiresAt: value.project.expiresAt!.toISOString(),
            purgeCompletedAt: now.toISOString(),
            objectCount: rows!.count,
            totalBytes: rows!.bytes.toString(),
            deleteAfter: new Date(now.getTime() + 90 * 86400000).toISOString(),
          },
        };
      });
      if (!ready) return { kind: "complete" };
      if (ready.kind === "sleep")
        return ready.dueAt <= ready.now ? { kind: "complete" } : { kind: "sleep", dueAt: ready.dueAt };
      await options.writeDeletionReceipt(receiptKey(ready.project.id), ready.proof);
      const outcome = await options.database.$transaction(async (tx) => {
        const value = await state(tx, ref);
        if (!value?.project) return { dispatchIds: [] };
        return executeExecutionPage(tx, ref, "maintenance-page", async () => {
          if (
            (
              await tx.$queryRaw<
                Array<{ id: string }>
              >`SELECT m.id FROM "MediaCleanupObligation" m WHERE m."projectId"=${ready.project.id}::uuid AND m."completedAt" IS NULL AND NOT EXISTS(SELECT 1 FROM "VisualAsset" v WHERE v."storageKey"=m."objectKey" AND v."deletedAt" IS NULL) LIMIT 1`
            ).length
          )
            throw Error("project_retention_cleanup_changed");
          await options.releaseUsage(tx, ready.project.id);
          await tx.project.delete({ where: { id: ready.project.id } });
          await tx.projectDeletionReceipt.upsert({
            where: { projectIdHash: ready.proof.projectIdHash },
            create: {
              projectIdHash: ready.proof.projectIdHash,
              retentionPolicyKey: ready.proof.retentionPolicyKey,
              expiresAt: new Date(ready.proof.expiresAt),
              purgeCompletedAt: new Date(ready.proof.purgeCompletedAt),
              objectCount: ready.proof.objectCount,
              totalBytes: BigInt(ready.proof.totalBytes),
              tombstoneStorageKey: receiptKey(ready.project.id),
              deleteAfter: new Date(ready.proof.deleteAfter),
            },
            update: {},
          });
          return { kind: "complete", processed: 1, dispatchIds: [] };
        });
      });
      await options.register(outcome.dispatchIds);
      return { kind: "complete" };
    },
  };
}
