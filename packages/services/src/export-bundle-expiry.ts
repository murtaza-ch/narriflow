import type { ExportBundle, Prisma } from "@prisma/client";
import { appendExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { lockWorkspaceUsage } from "./processing-usage";
import { sha256Hex } from "./execution-hash";

type Tx = Prisma.TransactionClient;
type ExpiryIdentity = Pick<ExportBundle, "id" | "workflowRunId" | "inputBindingHash" | "storageKey" | "sizeBytes" | "checksumSha256" | "expiresAt">;

export async function exportBundleExpiryInputHash(bundle: ExpiryIdentity): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([bundle.id, bundle.workflowRunId, bundle.inputBindingHash,
    bundle.checksumSha256, bundle.sizeBytes?.toString(), bundle.expiresAt?.toISOString()]));
  return await sha256Hex(bytes);
}

/** The result and its exact absolute expiry obligation commit together. */
export async function appendExportBundleExpiry(tx: Tx, bundle: ExportBundle): Promise<string | null> {
  if (bundle.status !== "completed" || !bundle.storageKey || !bundle.expiresAt) return null;
  const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT epoch FROM "ExecutionEpoch" WHERE id=1 FOR SHARE`;
  if (!epoch) throw Error("export_bundle_epoch_unavailable");
  const dispatch = await appendExecutionDispatch(tx, { deploymentEpoch: epoch.epoch, generation: 1, kind: "maintenance",
    subject: { kind: "export_bundle", id: bundle.id }, inputHash: await exportBundleExpiryInputHash(bundle),
    dueAt: bundle.expiresAt, deadlineKind: "operation", observedDeadlineAt: bundle.expiresAt });
  collectExecutionDispatch(tx, dispatch.reference.dispatchId);
  return dispatch.reference.dispatchId;
}

export type ExportBundleExpiryResult = { kind: "expired" | "terminal" | "superseded" } | { kind: "sleep"; dueAt: Date };

/** One known accepted Bundle, one observed expiry. No storage I/O or table scan. */
export async function expireExportBundle(tx: Tx, bundleId: string, observedExpiry: Date): Promise<ExportBundleExpiryResult> {
  if (!Number.isFinite(observedExpiry.getTime())) return { kind: "superseded" };
  const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT epoch FROM "ExecutionEpoch" WHERE id=1 FOR SHARE`;
  if (!epoch) throw Error("export_bundle_epoch_unavailable");
  const initial = await tx.exportBundle.findUnique({ where: { id: bundleId }, select: { workflowRunId: true,
    operation: { select: { workspaceId: true, projectId: true, workflowRunId: true } } } });
  if (!initial) return { kind: "terminal" };
  await lockWorkspaceUsage(tx, initial.operation.workspaceId);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${initial.operation.projectId},0)) IS NULL AS locked`;
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${initial.operation.projectId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${initial.workflowRunId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "ExportBundle" WHERE id=${bundleId}::uuid FOR UPDATE`;
  const bundle = await tx.exportBundle.findUnique({ where: { id: bundleId } });
  if (!bundle) return { kind: "terminal" };
  if (!bundle.expiresAt || bundle.expiresAt.getTime() !== observedExpiry.getTime()) return { kind: "superseded" };
  if (!["completed", "expired"].includes(bundle.status)) return { kind: "terminal" };
  const run = await tx.workflowRun.findUnique({ where: { id: bundle.workflowRunId }, select: { projectId: true, stage: true } });
  if (!run || run.projectId !== initial.operation.projectId || run.stage !== "export_bundle" || initial.operation.workflowRunId !== bundle.workflowRunId) throw Error("export_bundle_expiry_invalid");
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  if (!clock) throw Error("export_bundle_epoch_unavailable");
  if (bundle.expiresAt > clock.now) return { kind: "sleep", dueAt: bundle.expiresAt };
  // The immutable result facts identify the same ZIP on a replay after its public
  // reference has been cleared. A committed artifact is required before deletion.
  if (!bundle.inputBindingHash || !bundle.sizeBytes || !bundle.checksumSha256) throw Error("export_bundle_expiry_invalid");
  const artifacts = await tx.executionArtifact.findMany({ where: { role: "export_bundle", bindingHash: bundle.inputBindingHash,
    checksumSha256: bundle.checksumSha256, byteLength: bundle.sizeBytes, committedAt: { not: null },
    ...(bundle.storageKey ? { storageKey: bundle.storageKey } : {}),
    attempt: { functionName: "export_bundle", dispatch: { subjectKind: "workflow_run", subjectId: bundle.workflowRunId } } }, take: 2 });
  if (artifacts.length > 1 || bundle.status === "completed" && (!bundle.storageKey || artifacts.length !== 1)) throw Error("export_bundle_expiry_invalid");
  if (artifacts[0]) await admitMediaCleanupObligations(tx, [{ origin: "assigned_execution_artifact", cleanupClass: "assigned_artifact",
    projectId: run.projectId, objectKey: artifacts[0].storageKey, notBefore: new Date(bundle.expiresAt.getTime() + 120_000) }]);
  if (bundle.status === "completed") await tx.exportBundle.update({ where: { id: bundle.id }, data: { status: "expired", storageKey: null } });
  return { kind: "expired" };
}
