import type { Prisma, PrismaClient, WorkspaceBillingAccount } from "@prisma/client";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { readExecutionAdmission } from "./execution-admission";
import { lockWorkspaceUsage } from "./processing-usage";

type Tx = Prisma.TransactionClient;
export interface BillingReconciliationClaim { workspaceId: string; attemptId: string; attemptCount: number; dueAt: Date }
type Result = { kind: "complete" | "superseded" } | { kind: "sleep" | "wait"; dueAt: Date };
async function inputHash(row: WorkspaceBillingAccount): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["billing-reconciliation-v1", row.workspaceId,
    row.reconciliationEpoch, row.reconciliationGeneration, row.nextReconcileAt.toISOString(),
    row.providerCustomerId, row.canonicalSubscriptionId, row.seatRevision]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2,"0")).join("");
}
async function append(tx: Tx, row: WorkspaceBillingAccount) {
  const record = await appendExecutionDispatch(tx, { deploymentEpoch: row.reconciliationEpoch, generation: row.reconciliationGeneration,
    kind: "operation_driver", subject: { kind: "workspace_billing", id: row.workspaceId }, inputHash: await inputHash(row), dueAt: row.nextReconcileAt });
  collectExecutionDispatch(tx, record.reference.dispatchId);
  return record.reference;
}

/** Caller owns the billing mutation transaction and takes epoch before usage
 * locks. A changed due fact revokes the preceding provider claim. */
async function bindBillingReconciliation(tx: Tx, workspaceId: string) {
  const { epoch } = await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
  return tx.workspaceBillingAccount.update({ where: { workspaceId }, data: {
    reconciliationEpoch: epoch, reconciliationGeneration: { increment: 1 }, reconcileAttemptId: null, leaseExpiresAt: null,
  } });
}
export async function queueBillingReconciliation(tx: Tx, workspaceId: string): Promise<ExecutionDispatchReference> {
  return append(tx, await bindBillingReconciliation(tx,workspaceId));
}
/** A receipt retry repairs registration without admitting a new generation. */
export async function recoverBillingReconciliation(tx: Tx, workspaceId: string, options?: { deferDispatch: true }): Promise<ExecutionDispatchReference | null> {
  if (options?.deferDispatch && (await readExecutionAdmission(tx)).admissionOpen) throw Error("billing_restore_requires_closed_admission");
  await tx.$queryRaw`SELECT "id" FROM "WorkspaceBillingAccount" WHERE "workspaceId"=${workspaceId}::uuid FOR UPDATE`;
  let row = await tx.workspaceBillingAccount.findUnique({ where: { workspaceId } });
  if (!row) return null;
  const { epoch } = await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
  if (row.reconciliationGeneration === 0 || row.reconciliationEpoch !== epoch) row = await bindBillingReconciliation(tx,workspaceId);
  return options?.deferDispatch ? null : append(tx,row);
}

export async function appendBillingLeaseWatchdog(tx: Tx, reference: ExecutionDispatchReference, deadline: Date) {
  const watchdog = await appendExecutionDispatch(tx, { ...reference, subject: reference.subject, dueAt: deadline,
    wakeKind: "billing_lease", deadlineKind: "lease", observedDeadlineAt: deadline });
  collectExecutionDispatch(tx, watchdog.reference.dispatchId);
  return watchdog.reference.dispatchId;
}

/** One exact account per command. Provider I/O runs after claim+watchdog commit,
 * with no SQL transaction or connection held across the call. */
export function createBillingReconciliation(options: {
  database: PrismaClient;
  leaseMs: number;
  register(ids: readonly string[]): Promise<void>;
  reconcile(claim: BillingReconciliationClaim): Promise<void>;
}) {
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 30_000 || options.leaseMs > 300_000) throw new Error("billing_lease_invalid");
  const db = options.database;
  return { async run(value: ExecutionDispatchReference): Promise<Result> {
    const reference = executionDispatchReferenceSchema.parse(value);
    const prepared = await db.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx);
      const record = await readExecutionDispatch(tx, reference.dispatchId);
      if (reference.subject.kind !== "workspace_billing" || reference.kind !== "operation_driver" || reference.deploymentEpoch !== epoch ||
        !record || JSON.stringify(record.reference) !== JSON.stringify(reference)) return { kind: "superseded" as const };
      await lockWorkspaceUsage(tx, reference.subject.id);
      await tx.$queryRaw`SELECT "id" FROM "WorkspaceBillingAccount" WHERE "workspaceId"=${reference.subject.id}::uuid FOR UPDATE`;
      let row = await tx.workspaceBillingAccount.findUnique({ where: { workspaceId: reference.subject.id } });
      if (!row || row.reconciliationEpoch !== epoch || row.reconciliationGeneration !== reference.generation || await inputHash(row) !== reference.inputHash) return { kind: "superseded" as const };
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
      if (!clock) throw new Error("billing_clock_unavailable");
      if (row.nextReconcileAt > clock.now) return { kind: "sleep" as const, dueAt: row.nextReconcileAt };
      const held = row.reconcileAttemptId !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt > clock.now;
      if (!held) row = await tx.workspaceBillingAccount.update({ where: { workspaceId: row.workspaceId }, data: {
        reconcileAttemptId: crypto.randomUUID(), leaseExpiresAt: new Date(clock.now.getTime() + options.leaseMs), attemptCount: { increment: 1 },
      } });
      const deadline = row.leaseExpiresAt!;
      const watchdogId = await appendBillingLeaseWatchdog(tx, reference, deadline);
      const claim: BillingReconciliationClaim = { workspaceId: row.workspaceId, attemptId: row.reconcileAttemptId!, attemptCount: row.attemptCount, dueAt: row.nextReconcileAt };
      return { kind: held ? "held" as const : "claimed" as const, dueAt: deadline, claim, watchdogId };
    });
    if (prepared.kind === "superseded") {
      const current = await db.$transaction(async tx => {
        const { epoch } = await readExecutionAdmission(tx), record = await readExecutionDispatch(tx,reference.dispatchId);
        if (reference.kind !== "operation_driver" || reference.subject.kind !== "workspace_billing" || epoch !== reference.deploymentEpoch ||
          !record || JSON.stringify(record.reference) !== JSON.stringify(reference)) return null;
        await lockWorkspaceUsage(tx,reference.subject.id);
        await tx.$queryRaw`SELECT id FROM "WorkspaceBillingAccount" WHERE "workspaceId"=${reference.subject.id}::uuid FOR UPDATE`;
        const row = await tx.workspaceBillingAccount.findUnique({ where: { workspaceId: reference.subject.id } });
        if (!row || row.reconciliationEpoch !== epoch || row.reconciliationGeneration < reference.generation) return null;
        return recoverBillingReconciliation(tx,reference.subject.id);
      });
      // A late receipt may repair the current accepted due fact, but cannot
      // grant another provider claim or change its immutable registration.
      if (current) await options.register([current.dispatchId]);
      return prepared;
    }
    if (prepared.kind === "sleep") return prepared;
    try { await options.register([prepared.watchdogId]); }
    catch (error) {
      if (prepared.kind === "claimed") await db.$transaction(async tx => {
        const { epoch } = await readExecutionAdmission(tx);
        if (epoch !== reference.deploymentEpoch) return;
        await lockWorkspaceUsage(tx, reference.subject.id);
        await tx.workspaceBillingAccount.updateMany({ where: { workspaceId: reference.subject.id,
          reconciliationEpoch: epoch, reconciliationGeneration: reference.generation, reconcileAttemptId: prepared.claim.attemptId },
          data: { reconcileAttemptId: null, leaseExpiresAt: null, attemptCount: { decrement: 1 } } });
      });
      throw error;
    }
    if (prepared.kind === "held") return { kind: "wait", dueAt: prepared.dueAt };
    try { await options.reconcile(prepared.claim); }
    catch {
      // Unexpected adapter failure still releases the finite claim and commits
      // the next due fact. A platform retry cannot reuse its provider authority.
      const retry = await db.$transaction(async tx => {
        const { epoch } = await readExecutionAdmission(tx);
        if (epoch !== reference.deploymentEpoch) return null;
        await lockWorkspaceUsage(tx, reference.subject.id);
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
        if (!clock) throw new Error("billing_clock_unavailable");
        const changed = await tx.workspaceBillingAccount.updateMany({ where: { workspaceId: reference.subject.id,
          reconciliationGeneration: reference.generation, reconciliationEpoch: epoch, reconcileAttemptId: prepared.claim.attemptId },
          data: { nextReconcileAt: new Date(clock.now.getTime() + Math.min(3_600_000, 60_000 * 2 ** Math.min(6, prepared.claim.attemptCount - 1))), health: "retrying", attentionReason: "retryable_provider" } });
        return changed.count ? queueBillingReconciliation(tx, reference.subject.id) : null;
      });
      if (retry) await options.register([retry.dispatchId]);
    }
    const current = await db.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx);
      if (epoch !== reference.deploymentEpoch) return null;
      return recoverBillingReconciliation(tx, reference.subject.id);
    });
    if (current) await options.register([current.dispatchId]);
    return { kind: "complete" };
  } };
}
