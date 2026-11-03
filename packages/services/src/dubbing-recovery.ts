import { Prisma } from "@prisma/client";
import { lockWorkspaceUsage } from "./processing-usage";
import { lockGenerationUsage } from "./generated-media-usage-ledger";
import { appendWorkflowRunDispatch } from "./workflow-dispatch";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch, takeExecutionDispatchIds } from "./execution-dispatch-runtime";
import { readExecutionAdmission } from "./execution-admission";
import type { ExecutionRestorePage } from "./execution-restore";
import type { MaintenancePage } from "./execution-maintenance";

type Tx = Prisma.TransactionClient;
export type DubbingRestoreProof = Pick<ExecutionRestorePage, "snapshotEpoch" | "fenceAboveEpoch" | "deploymentEpoch" | "cutoff">;
async function requireProof(tx: Tx, proof: DubbingRestoreProof) {
  const [epoch] = await tx.$queryRaw<Array<{ epoch: number; admissionOpen: boolean; changedAt: Date }>>`SELECT epoch,"admissionOpen","changedAt" FROM "ExecutionEpoch" WHERE id=1 FOR SHARE`;
  if (!epoch || epoch.admissionOpen || epoch.epoch !== proof.deploymentEpoch || proof.deploymentEpoch !== Math.max(proof.snapshotEpoch, proof.fenceAboveEpoch) + 1 ||
    ![proof.snapshotEpoch, proof.fenceAboveEpoch].every(value => Number.isSafeInteger(value) && value >= 1) || epoch.changedAt.getTime() !== proof.cutoff.getTime()) throw Error("dubbing_restore_fence_invalid");
}

/** Metadata phase only. Paid intents/results and the original accepted budget
 * survive restore. Final preparation classifies any unsealed paid intent as
 * unknown before it can admit another native attempt. */
export async function restoreDubWithinTransaction(tx: Tx, id: string, proof: DubbingRestoreProof): Promise<{ dispatchIds: string[] }> {
  await requireProof(tx, proof);
  const initial = await tx.clipDub.findUnique({ where: { id }, select: { workflowRunId: true, projectId: true, project: { select: { workspaceId: true } } } });
  if (!initial?.workflowRunId) return { dispatchIds: [] };
  await lockWorkspaceUsage(tx, initial.project.workspaceId);await lockGenerationUsage(tx, initial.project.workspaceId);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${initial.projectId},0)) IS NULL AS locked`;
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${initial.projectId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${initial.workflowRunId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "ClipDub" WHERE id=${id}::uuid FOR UPDATE`;
  const dub = await tx.clipDub.findUniqueOrThrow({ where: { id } });
  if (dub.createdAt > proof.cutoff || !["queued", "processing"].includes(dub.status)) return { dispatchIds: [] };
  if (!dub.frozenRequest || !dub.requestHash || !dub.operationDeadlineAt) throw Error("dubbing_restore_request_invalid");
  const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: initial.workflowRunId } });
  if (run.deploymentEpoch !== proof.deploymentEpoch || run.projectId !== initial.projectId || run.stage !== "dubbing" || run.status !== "queued" ||
    run.attemptId || run.leaseOwner || run.leaseExpiresAt || dub.deploymentEpoch > proof.deploymentEpoch) throw Error("dubbing_restore_parent_not_quiesced");
  const permission = await tx.executionAttempt.findFirst({ where: { deploymentEpoch: { lt: proof.deploymentEpoch }, status: { in: ["admitted", "running"] },
    dispatch: { subjectKind: "workflow_run", subjectId: run.id } }, select: { attemptToken: true } });
  if (permission) throw Error("dubbing_restore_owner_not_revoked");
  if (run.operationDeadlineAt && run.operationDeadlineAt.getTime() !== dub.operationDeadlineAt.getTime()) throw Error("dubbing_restore_deadline_invalid");
  if (dub.deploymentEpoch < proof.deploymentEpoch) await tx.clipDub.update({ where: { id }, data: { deploymentEpoch: proof.deploymentEpoch,
    status: "queued", inputBindingHash: null, inputStorageKey: null, inputEtag: null, inputByteLength: null, inputChecksumSha256: null } });
  if (!run.operationDeadlineAt) await tx.workflowRun.update({ where: { id: run.id }, data: { operationDeadlineAt: dub.operationDeadlineAt } });
  return { dispatchIds: [] };
}

function limit(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw Error("dubbing_recovery_page_invalid");
  return value;
}
type Row = { id: string; at: Date; workspaceId: string; projectId: string; workflowRunId: string };
async function lockParents(tx: Tx, rows: readonly Row[]) {
  const workspaces = [...new Set(rows.map(row => row.workspaceId))].sort();
  for (const id of workspaces) { await lockWorkspaceUsage(tx, id);await lockGenerationUsage(tx, id); }
  for (const id of workspaces) await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${id}::uuid FOR UPDATE`;
  for (const id of [...new Set(rows.map(row => row.projectId))].sort()) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id},0)) IS NULL AS locked`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${id}::uuid FOR UPDATE`;
  }
  for (const id of [...new Set(rows.map(row => row.workflowRunId))].sort()) await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${id}::uuid FOR UPDATE`;
}

export async function restoreDubbingPage(tx: Tx, page: ExecutionRestorePage) {
  const maximum = limit(page.limit);await requireProof(tx, page);
  const after = page.after ? Prisma.sql`AND (dub."createdAt",dub.id)>((${page.after.at}::timestamp),${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<Row[]>`SELECT dub.id,dub."createdAt" AS at,dub."workflowRunId",dub."projectId",project."workspaceId" FROM "ClipDub" dub
    JOIN "Project" project ON project.id=dub."projectId" WHERE dub.status IN ('queued','processing') AND dub."workflowRunId" IS NOT NULL AND dub."frozenRequest" IS NOT NULL
      AND dub."deploymentEpoch"<${page.deploymentEpoch} AND dub."createdAt"<=(${page.cutoff}::timestamp) ${after}
    ORDER BY dub."createdAt",dub.id LIMIT ${maximum + 1}`;
  const selected = rows.slice(0, maximum);await lockParents(tx, selected);
  for (const row of selected) await restoreDubWithinTransaction(tx, row.id, page);
  return { processed: selected.length, next: rows.length > maximum ? { at: selected.at(-1)!.at, id: selected.at(-1)!.id } : null, dispatchIds: [] };
}

/** Final redispatch and daily known-row repair. No SQL owns a native lease or
 * calls a provider here; current preparation enforces every paid-stage fence. */
export async function recoverDubbingWakesPage(tx: Tx, page: MaintenancePage) {
  const maximum = limit(page.limit);
  if ((await readExecutionAdmission(tx)).epoch !== page.deploymentEpoch || page.after?.tie) throw Error("dubbing_recovery_page_invalid");
  const after = page.after ? Prisma.sql`AND (dub."createdAt",dub.id)>((${page.after.at}::timestamp),${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<Row[]>`SELECT dub.id,dub."createdAt" AS at,dub."workflowRunId",dub."projectId",project."workspaceId" FROM "ClipDub" dub
    JOIN "Project" project ON project.id=dub."projectId" WHERE dub.status IN ('queued','processing') AND dub."workflowRunId" IS NOT NULL AND dub."frozenRequest" IS NOT NULL
      AND dub."deploymentEpoch"=${page.deploymentEpoch} AND dub."createdAt"<=(${page.cutoff}::timestamp) ${after}
    ORDER BY dub."createdAt",dub.id LIMIT ${maximum + 1}`;
  const selected = rows.slice(0, maximum);await lockParents(tx, selected);
  for (const row of selected) {
    const dub = await tx.clipDub.findUniqueOrThrow({ where: { id: row.id } }), run = await tx.workflowRun.findUniqueOrThrow({ where: { id: row.workflowRunId } });
    if (dub.deploymentEpoch !== page.deploymentEpoch || run.deploymentEpoch !== page.deploymentEpoch || run.stage !== "dubbing" || !["queued", "processing"].includes(dub.status)) continue;
    if (!dub.operationDeadlineAt || !dub.frozenRequest || !dub.requestHash || run.operationDeadlineAt && run.operationDeadlineAt.getTime() !== dub.operationDeadlineAt.getTime()) throw Error("dubbing_recovery_request_invalid");
    const prior = await tx.executionDispatch.findFirst({ where: { kind: "operation_driver", subjectKind: "workflow_run", subjectId: run.id, generation: run.generation,
      deploymentEpoch: page.deploymentEpoch, wakeKind: null, deadlineKind: null }, select: { id: true } });
    const driver = prior ? (await readExecutionDispatch(tx, prior.id))! : await appendWorkflowRunDispatch(tx, run.id);
    const watch = await appendExecutionDispatch(tx, { ...driver.reference, dueAt: dub.operationDeadlineAt, deadlineKind: "operation", observedDeadlineAt: dub.operationDeadlineAt });
    collectExecutionDispatch(tx, driver.reference.dispatchId);collectExecutionDispatch(tx, watch.reference.dispatchId);
  }
  return { processed: selected.length, next: rows.length > maximum ? { at: selected.at(-1)!.at, id: selected.at(-1)!.id } : null, dispatchIds: takeExecutionDispatchIds(tx) };
}
