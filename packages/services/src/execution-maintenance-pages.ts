import { executionDispatchReferenceSchema } from "@narriflow/validators/execution";
import { appendExecutionDispatches } from "./execution-dispatch";
import { Prisma } from "@prisma/client";
import type { MaintenancePhaseHandler, MaintenancePosition } from "./execution-maintenance";

/** Task expiry removes only the request-owned handle. The domain's work and
 * settlement history continue independently. */
export const expireMcpTaskPage: MaintenancePhaseHandler = async (tx, page) => {
  const after = page.after ? Prisma.sql`AND ("expiresAt", id) > ((${page.after.at}::timestamp), ${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ id: string; at: Date }>>`SELECT id, "expiresAt" AS at FROM "McpTask"
    WHERE "expiresAt" <= (${page.cutoff}::timestamp) ${after}
    ORDER BY "expiresAt", id LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit);
  if (selected.length) await tx.mcpTask.deleteMany({ where: { id: { in: selected.map(row => row.id) }, expiresAt: { lte: page.cutoff } } });
  return { processed: selected.length, next: rows.length > page.limit ? selected.at(-1)! : null };
};

/** The hourly pass only repairs registration of existing current-epoch ledger
 * facts. Delivery/claim authority is rechecked by the outbox after commit. */
export const recoverPendingDispatchPage: MaintenancePhaseHandler = async (tx, page) => {
  const after = page.after ? Prisma.sql`AND ("nextDeliveryAt", id) > ((${page.after.at}::timestamp), ${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ id: string; at: Date }>>`SELECT id, "nextDeliveryAt" AS at FROM "ExecutionDispatch"
    WHERE "deploymentEpoch" = ${page.deploymentEpoch} AND "acknowledgedAt" IS NULL AND "deadLetteredAt" IS NULL
      AND "nextDeliveryAt" <= (${page.cutoff}::timestamp) AND ("deliveryLeaseExpiresAt" IS NULL OR "deliveryLeaseExpiresAt" <= clock_timestamp() AT TIME ZONE 'UTC') ${after}
    ORDER BY "nextDeliveryAt", id LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit);
  return { processed: selected.length, next: rows.length > page.limit ? selected.at(-1)! : null, dispatchIds: selected.map(row => row.id) };
};

/** A bounded indexed observation page, never an alternative expiry mutation.
 * The targeted handler resolves its original attempt and re-reads all clocks. */
export const recoverExecutionDeadlinePage: MaintenancePhaseHandler = async (tx, page) => {
  const due = Prisma.sql`LEAST(COALESCE("leaseExpiresAt", "operationDeadlineAt"), "operationDeadlineAt")`;
  const after = page.after ? Prisma.sql`AND (${due}, "attemptToken") > ((${page.after.at}::timestamp), ${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ id: string; at: Date; dispatchId: string; leaseExpiresAt: Date | null; operationDeadlineAt: Date }>>`SELECT "attemptToken" AS id, ${due} AS at, "dispatchId", "leaseExpiresAt", "operationDeadlineAt" FROM "ExecutionAttempt"
    WHERE "deploymentEpoch" = ${page.deploymentEpoch} AND status IN ('admitted','running') AND ${due} <= (${page.cutoff}::timestamp) ${after}
    ORDER BY ${due}, "attemptToken" LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit);
  const originals = await tx.executionDispatch.findMany({ where: { id: { in: selected.map(row => row.dispatchId) } }, select: { id: true, kind: true, subjectKind: true, subjectId: true, deploymentEpoch: true, generation: true, inputHash: true } });
  const targets = new Map(originals.map(row => [row.id, executionDispatchReferenceSchema.parse({ dispatchId: row.id, deploymentEpoch: row.deploymentEpoch, generation: row.generation, kind: row.kind, subject: { kind: row.subjectKind, id: row.subjectId }, inputHash: row.inputHash })]));
  const dispatches = await appendExecutionDispatches(tx, selected.map(row => {
    const target = targets.get(row.dispatchId);
    if (!target || target.deploymentEpoch !== page.deploymentEpoch) throw new Error("maintenance_attempt_dispatch_invalid");
    const kind = !row.leaseExpiresAt || row.operationDeadlineAt <= row.leaseExpiresAt ? "operation" as const : "lease" as const;
    return { ...target, subject: target.subject, kind: "operation_driver" as const, dueAt: row.at, wakeKind: `hourly_deadline.${page.cutoff.getTime()}`, deadlineKind: kind, observedDeadlineAt: row.at };
  }));
  const dispatchIds = dispatches.map(row => row.reference.dispatchId);
  return { processed: selected.length, next: rows.length > page.limit ? selected.at(-1)! : null, dispatchIds };
};

/** All receipt namespaces have one strict (expiry, delivery UUID, audience)
 * cursor. A UUID shared by two audiences cannot strand the second receipt. */
export const expireExecutionInboxPage: MaintenancePhaseHandler = async (tx, page) => {
  if (page.after && !page.after.tie) throw new Error("maintenance_receipt_cursor_invalid");
  const after = page.after ? Prisma.sql`AND ("expiresAt", "deliveryId", audience) > ((${page.after.at}::timestamp), ${page.after.id}::uuid, ${page.after.tie})` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ id: string; at: Date; tie: NonNullable<MaintenancePosition["tie"]> }>>`SELECT "deliveryId" AS id, "expiresAt" AS at, audience AS tie FROM "ExecutionInboxReceipt"
    WHERE "expiresAt" <= (${page.cutoff}::timestamp) ${after} ORDER BY "expiresAt", "deliveryId", audience LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit);
  if (selected.length) await tx.executionInboxReceipt.deleteMany({ where: { expiresAt: { lte: page.cutoff }, OR: selected.map(row => ({ deliveryId: row.id, audience: row.tie })) } });
  return { processed: selected.length, next: rows.length > page.limit ? selected.at(-1)! : null };
};
