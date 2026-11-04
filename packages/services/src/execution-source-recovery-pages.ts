import { Prisma } from "@prisma/client";
import { assertExecutionRestorePage } from "./execution-restore-pages";
import type {
  ExecutionRestorePage,
  ExecutionRestorePhaseHandler,
} from "./execution-restore";
import { lockExecutionRecoveryParents } from "./execution-recovery-locks";

type Tx = Prisma.TransactionClient;
const cursor = (page: ExecutionRestorePage, alias: string) =>
  page.after
    ? Prisma.sql`AND (${Prisma.raw(`${alias}."createdAt"`)},${Prisma.raw(`${alias}.id`)})>((${page.after.at}::timestamp),${page.after.id}::uuid)`
    : Prisma.empty;
type Row = { id: string; at: Date; projectId: string; workspaceId: string };
async function candidates(
  tx: Tx,
  page: ExecutionRestorePage,
  table: "IngestJob" | "WorkflowRun" | "RenderGroup",
  active: Prisma.Sql,
) {
  await assertExecutionRestorePage(tx, page);
  const project =
    table === "RenderGroup"
      ? Prisma.sql`JOIN "WorkflowRun" parent ON parent.id=d."workflowRunId" JOIN "Project" p ON p.id=parent."projectId"`
      : Prisma.sql`JOIN "Project" p ON p.id=d."projectId"`;
  return tx.$queryRaw<
    Row[]
  >(Prisma.sql`SELECT d.id,d."createdAt" AS at,p.id AS "projectId",p."workspaceId" FROM ${Prisma.raw(`"${table}"`)} d ${project}
    WHERE d."deploymentEpoch"<=${page.snapshotEpoch} AND (${active}) AND d."createdAt"<=(${page.cutoff}::timestamp) ${cursor(page, "d")}
    ORDER BY d."createdAt",d.id LIMIT ${page.limit + 1}`);
}
const outcome = (rows: Row[], page: ExecutionRestorePage) => ({
  processed: Math.min(rows.length, page.limit),
  next: rows.length > page.limit ? rows[page.limit - 1]! : null,
  dispatchIds: [],
});
/** The first rs2 attempt page has already revoked old generic permissions.
 * Domain rebinding changes no usage settlement, charged count or absolute timer. */
export const restoreIngestJobsPage: ExecutionRestorePhaseHandler = async (
  tx,
  page,
) => {
  const rows = await candidates(
      tx,
      page,
      "IngestJob",
      Prisma.sql`d.status IN ('queued','running') OR (d.status='completed' AND d."generationHandoffAt" IS NULL)`,
    ),
    selected = rows.slice(0, page.limit);
  await lockExecutionRecoveryParents(tx, selected);
  for (const item of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
    await tx.$queryRaw`SELECT id FROM "IngestJob" WHERE id=${item.id}::uuid FOR UPDATE`;
    const job = await tx.ingestJob.findUniqueOrThrow({
        where: { id: item.id },
      }),
      project = await tx.project.findUniqueOrThrow({
        where: { id: item.projectId },
      });
    if (job.deploymentEpoch > page.snapshotEpoch) continue;
    if (job.sourceRevision !== project.sourceRevision)
      throw Error("restore_ingest_source_superseded");
    // Expired Projects remain fenced for their dedicated privacy purge; no
    // execution owner or unsettled usage is fabricated by restoration.
    if (
      project.purgeStartedAt ||
      (project.expiresAt && project.expiresAt <= page.cutoff)
    )
      continue;
    await tx.ingestJob.update({
      where: { id: job.id },
      data: {
        deploymentEpoch: page.deploymentEpoch,
        generation: { increment: 1 },
        status: job.status === "completed" ? "completed" : "queued",
        claimId: null,
        executorOwner: null,
        claimExpiresAt: null,
        ...(job.status === "completed" ? {} : { completedAt: null }),
      },
    });
  }
  return outcome(rows, page);
};
export const restoreWorkflowRunsPage: ExecutionRestorePhaseHandler = async (
  tx,
  page,
) => {
  const rows = await candidates(
      tx,
      page,
      "WorkflowRun",
      Prisma.sql`d.status IN ('queued','running','waiting')`,
    ),
    selected = rows.slice(0, page.limit);
  await lockExecutionRecoveryParents(tx, selected);
  for (const item of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
    await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${item.id}::uuid FOR UPDATE`;
    const run = await tx.workflowRun.findUniqueOrThrow({
      where: { id: item.id },
    });
    if (run.deploymentEpoch > page.snapshotEpoch) continue;
    if (
      ![
        "stt",
        "moment_detection",
        "clip_rendering",
        "dubbing",
        "export_bundle",
      ].includes(run.stage)
    )
      throw Error("restore_workflow_stage_unsupported");
    const transcript =
      run.stage === "stt"
        ? await tx.transcript.findUnique({
            where: { projectId: run.projectId },
          })
        : null;
    const providerWaiting =
      run.stage === "stt" &&
      run.status === "waiting" &&
      run.attemptId !== null &&
      transcript?.workflowAttemptId === run.attemptId &&
      (transcript.providerSubmissionDeadlineAt !== null ||
        transcript.providerResultDeadlineAt !== null);
    const windows =
      run.stage === "moment_detection"
        ? await tx.clipSelectionWindow.findFirst({
            where: {
              workflowRunId: run.id,
              workflowGeneration: run.generation,
            },
            select: { id: true },
          })
        : null;
    await tx.workflowRun.update({
      where: { id: run.id },
      data: {
        deploymentEpoch: page.deploymentEpoch,
        generation: { increment: 1 },
        status: providerWaiting ? "waiting" : "queued",
        attemptId: providerWaiting ? run.attemptId : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        ...(providerWaiting ? {} : { nextPollAt: null, waitingSince: null }),
        errorCode: windows
          ? "execution_restore_selection_pending"
          : run.errorCode,
      },
    });
  }
  return outcome(rows, page);
};
export const restoreRenderGroupsPage: ExecutionRestorePhaseHandler = async (
  tx,
  page,
) => {
  const rows = await candidates(
      tx,
      page,
      "RenderGroup",
      Prisma.sql`d.status IN ('queued','running')`,
    ),
    selected = rows.slice(0, page.limit);
  await lockExecutionRecoveryParents(tx, selected);
  const parents = await tx.renderGroup.findMany({
    where: { id: { in: selected.map((row) => row.id) } },
    select: { workflowRunId: true },
  });
  for (const id of [...new Set(parents.map((row) => row.workflowRunId))].sort())
    await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${id}::uuid FOR UPDATE`;
  for (const item of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
    await tx.$queryRaw`SELECT id FROM "RenderGroup" WHERE id=${item.id}::uuid FOR UPDATE`;
    const group = await tx.renderGroup.findUniqueOrThrow({
      where: { id: item.id },
      include: { workflowRun: true },
    });
    if (group.deploymentEpoch > page.snapshotEpoch) continue;
    if (
      group.workflowRun.deploymentEpoch !== page.deploymentEpoch ||
      group.workflowRun.status !== "queued" ||
      group.workflowRun.attemptId ||
      group.workflowRun.leaseOwner
    )
      throw Error("restore_render_parent_not_rebound");
    if (group.attemptToken)
      await tx.renderGroupExecution.updateMany({
        where: {
          token: group.attemptToken,
          groupId: group.id,
          finishedAt: null,
        },
        data: {
          finishedAt: page.cutoff,
          result: "superseded",
          errorCode: "execution_epoch_restored",
        },
      });
    await tx.renderGroup.update({
      where: { id: group.id },
      data: {
        deploymentEpoch: page.deploymentEpoch,
        generation: { increment: 1 },
        status: "queued",
        attemptToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        preparationId: null,
        inputStorageKey: null,
        inputEtag: null,
        inputByteLength: null,
        inputChecksumSha256: null,
        settledAt: null,
      },
    });
  }
  return outcome(rows, page);
};
