import { Prisma } from "@prisma/client";
import { lockWorkspaceUsage } from "./processing-usage";
import { appendWorkflowRunDispatch } from "./workflow-dispatch";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch, takeExecutionDispatchIds } from "./execution-dispatch-runtime";
import type { ExecutionRestorePage } from "./execution-restore";
import type { MaintenancePage } from "./execution-maintenance";
import { expireExportBundle } from "./export-bundle-expiry";
import { readExecutionAdmission } from "./execution-admission";

type Tx = Prisma.TransactionClient;
export type ExportBundleRestoreProof = Pick<ExecutionRestorePage, "snapshotEpoch" | "fenceAboveEpoch" | "deploymentEpoch" | "cutoff">;

async function requireRestoreProof(tx: Tx, proof: ExportBundleRestoreProof) {
  const [epoch] = await tx.$queryRaw<Array<{ epoch: number; admissionOpen: boolean; changedAt: Date }>>`SELECT epoch,"admissionOpen","changedAt" FROM "ExecutionEpoch" WHERE id=1 FOR SHARE`;
  if (!epoch || epoch.admissionOpen || epoch.epoch !== proof.deploymentEpoch || proof.deploymentEpoch !== Math.max(proof.snapshotEpoch, proof.fenceAboveEpoch) + 1 ||
    ![proof.snapshotEpoch, proof.fenceAboveEpoch].every(value => Number.isSafeInteger(value) && value >= 1) || epoch.changedAt.getTime() !== proof.cutoff.getTime()) throw Error("bundle_restore_fence_invalid");
}

/** Called only by the quiesced restore page, after the parent and historical
 * permissions have been fenced. Live preparation cannot rebind an old epoch. */
export async function restoreExportBundleWithinTransaction(tx: Tx, bundleId: string, proof: ExportBundleRestoreProof, options: { deferDispatch?: boolean } = {}): Promise<{ dispatchIds: string[] }> {
  await requireRestoreProof(tx, proof);
  const initial = await tx.exportBundle.findUnique({ where: { id: bundleId }, select: { workflowRunId: true, operation: { select: { projectId: true, workspaceId: true } } } });
  if (!initial) return { dispatchIds: [] };
  await lockWorkspaceUsage(tx, initial.operation.workspaceId);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${initial.operation.projectId},0)) IS NULL AS locked`;
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${initial.operation.projectId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${initial.workflowRunId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "ExportBundle" WHERE id=${bundleId}::uuid FOR UPDATE`;
  const bundle = await tx.exportBundle.findUniqueOrThrow({ where: { id: bundleId } });
  if (bundle.createdAt > proof.cutoff) return { dispatchIds: [] };
  if (!["queued", "building"].includes(bundle.status)) return { dispatchIds: [] };
  const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: bundle.workflowRunId } });
  if (run.deploymentEpoch !== proof.deploymentEpoch || run.projectId !== initial.operation.projectId || run.stage !== "export_bundle" || run.status !== "queued" ||
    run.attemptId || run.leaseOwner || run.leaseExpiresAt || bundle.deploymentEpoch > proof.deploymentEpoch) throw Error("bundle_restore_parent_not_quiesced");
  const permission = await tx.executionAttempt.findFirst({ where: { deploymentEpoch: { lt: proof.deploymentEpoch }, status: { in: ["admitted", "running"] },
    dispatch: { subjectKind: "workflow_run", subjectId: run.id } }, select: { attemptToken: true } });
  if (permission) throw Error("bundle_restore_owner_not_revoked");
  if (run.operationDeadlineAt && run.operationDeadlineAt.getTime() !== bundle.operationDeadlineAt.getTime()) throw Error("bundle_restore_deadline_invalid");
  if (bundle.deploymentEpoch < proof.deploymentEpoch) await tx.exportBundle.update({ where: { id: bundle.id }, data: { deploymentEpoch: proof.deploymentEpoch,
    status: "queued", attemptStorageKey: null, inputBindingHash: null, inputStorageKey: null, inputEtag: null, inputByteLength: null, inputChecksumSha256: null } });
  if (!run.operationDeadlineAt) await tx.workflowRun.update({ where: { id: run.id }, data: { operationDeadlineAt: bundle.operationDeadlineAt } });
  if (options.deferDispatch) return { dispatchIds: [] };
  const driver = await appendWorkflowRunDispatch(tx, run.id);
  const watchdog = await appendExecutionDispatch(tx, { ...driver.reference, dueAt: bundle.operationDeadlineAt, deadlineKind: "operation", observedDeadlineAt: bundle.operationDeadlineAt });
  const dispatchIds = [driver.reference.dispatchId, watchdog.reference.dispatchId];
  for (const id of dispatchIds) collectExecutionDispatch(tx, id);
  return { dispatchIds };
}

function pageLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw Error("bundle_recovery_page_invalid");
  return limit;
}

type PageRow = { id: string; at: Date; workspaceId: string; projectId: string; workflowRunId: string };
async function lockPageParents(tx: Tx, rows: readonly PageRow[]) {
  const workspaces = [...new Set(rows.map(row => row.workspaceId))].sort();
  for (const id of workspaces) await lockWorkspaceUsage(tx, id);
  for (const id of workspaces) await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${id}::uuid FOR UPDATE`;
  for (const id of [...new Set(rows.map(row => row.projectId))].sort()) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id},0)) IS NULL AS locked`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${id}::uuid FOR UPDATE`;
  }
  for (const id of [...new Set(rows.map(row => row.workflowRunId))].sort()) await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${id}::uuid FOR UPDATE`;
}

/** Exact indexed pages feed the same targeted expiry transition. */
export async function expireExportBundlesPage(tx: Tx, page: MaintenancePage) {
  const limit = pageLimit(page.limit);
  if ((await readExecutionAdmission(tx)).epoch !== page.deploymentEpoch || page.after?.tie) throw Error("bundle_recovery_page_invalid");
  const after = page.after ? Prisma.sql`AND (bundle."expiresAt",bundle.id)>((${page.after.at}::timestamptz AT TIME ZONE 'UTC'),${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<PageRow[]>`SELECT bundle.id,bundle."expiresAt" AS at,bundle."workflowRunId",operation."workspaceId",operation."projectId" FROM "ExportBundle" bundle
    JOIN "CampaignOperation" operation ON operation.id=bundle."operationId" WHERE bundle.status='completed' AND bundle."expiresAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after}
    ORDER BY bundle."expiresAt",bundle.id LIMIT ${limit + 1}`;
  const selected = rows.slice(0, limit);
  await lockPageParents(tx, selected);
  for (const row of selected) await expireExportBundle(tx, row.id, row.at);
  return { processed: selected.length, next: rows.length > limit ? { at: selected.at(-1)!.at, id: selected.at(-1)!.id } : null, dispatchIds: takeExecutionDispatchIds(tx) };
}

export async function restoreExportBundlesPage(tx: Tx, page: ExecutionRestorePage) {
  const limit = pageLimit(page.limit);
  await requireRestoreProof(tx, page);
  const after = page.after ? Prisma.sql`AND (bundle."createdAt",bundle.id)>((${page.after.at}::timestamptz AT TIME ZONE 'UTC'),${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<PageRow[]>`SELECT bundle.id,bundle."createdAt" AS at,bundle."workflowRunId",operation."workspaceId",operation."projectId" FROM "ExportBundle" bundle
    JOIN "CampaignOperation" operation ON operation.id=bundle."operationId" WHERE bundle.status IN ('queued','building') AND bundle."deploymentEpoch"<${page.deploymentEpoch}
      AND bundle."createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after} ORDER BY bundle."createdAt",bundle.id LIMIT ${limit + 1}`;
  const selected = rows.slice(0, limit);
  await lockPageParents(tx, selected);
  for (const row of selected) await restoreExportBundleWithinTransaction(tx, row.id, page, { deferDispatch: true });
  return { processed: selected.length, next: rows.length > limit ? { at: selected.at(-1)!.at, id: selected.at(-1)!.id } : null, dispatchIds: [] };
}

/** Repairs known accepted obligations without admitting another native owner. */
export async function recoverExportBundleWakesPage(tx: Tx, page: MaintenancePage) {
  const limit = pageLimit(page.limit);
  if ((await readExecutionAdmission(tx)).epoch !== page.deploymentEpoch || page.after?.tie) throw Error("bundle_recovery_page_invalid");
  const after = page.after ? Prisma.sql`AND (bundle."createdAt",bundle.id)>((${page.after.at}::timestamptz AT TIME ZONE 'UTC'),${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<PageRow[]>`SELECT bundle.id,bundle."createdAt" AS at,bundle."workflowRunId",operation."workspaceId",operation."projectId" FROM "ExportBundle" bundle
    JOIN "CampaignOperation" operation ON operation.id=bundle."operationId" WHERE bundle.status IN ('queued','building') AND bundle."deploymentEpoch"=${page.deploymentEpoch}
      AND bundle."createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after} ORDER BY bundle."createdAt",bundle.id LIMIT ${limit + 1}`;
  const selected = rows.slice(0, limit);
  await lockPageParents(tx, selected);
  for (const row of selected) {
    const bundle = await tx.exportBundle.findUniqueOrThrow({ where: { id: row.id } });
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: row.workflowRunId } });
    if (bundle.deploymentEpoch !== page.deploymentEpoch || run.deploymentEpoch !== page.deploymentEpoch || run.stage !== "export_bundle" || !["queued", "building"].includes(bundle.status)) continue;
    const prior = await tx.executionDispatch.findFirst({ where: { kind: "operation_driver", subjectKind: "workflow_run", subjectId: run.id, generation: run.generation,
      deploymentEpoch: page.deploymentEpoch, wakeKind: null, deadlineKind: null }, select: { id: true } });
    const driver = prior ? (await readExecutionDispatch(tx, prior.id))! : await appendWorkflowRunDispatch(tx, run.id);
    const watch = await appendExecutionDispatch(tx, { ...driver.reference, dueAt: bundle.operationDeadlineAt, deadlineKind: "operation", observedDeadlineAt: bundle.operationDeadlineAt });
    collectExecutionDispatch(tx, driver.reference.dispatchId);collectExecutionDispatch(tx, watch.reference.dispatchId);
  }
  return { processed: selected.length, next: rows.length > limit ? { at: selected.at(-1)!.at, id: selected.at(-1)!.id } : null, dispatchIds: takeExecutionDispatchIds(tx) };
}
