import type { Prisma } from "@prisma/client";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";

type Tx = Prisma.TransactionClient;
export type ExecutionPageAudience = "maintenance-page" | "restore-page";
export interface ExecutionPageOutcome { kind: "complete" | "continue"; processed: number; dispatchIds: string[] }
export class ExecutionPageReceiptError extends Error {
  constructor(readonly code: "execution_page_receipt_invalid" | "execution_page_expired") { super(code); }
}
const RETENTION_MS = 7 * 86_400_000;
function parse(disposition: unknown, ids: string[]): ExecutionPageOutcome {
  if (!disposition || typeof disposition !== "object" || Array.isArray(disposition)) throw new ExecutionPageReceiptError("execution_page_receipt_invalid");
  const value = disposition as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !["complete", "continue"].includes(value.kind as string) || typeof value.processed !== "number" ||
    !Number.isSafeInteger(value.processed) || value.processed < 0 || value.processed > 100 || ids.length > 128 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) throw new ExecutionPageReceiptError("execution_page_receipt_invalid");
  return { kind: value.kind as "complete" | "continue", processed: value.processed, dispatchIds: ids };
}
async function requestHash(reference: ExecutionDispatchReference, audience: ExecutionPageAudience) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    "execution-page-receipt-v1", audience, reference.dispatchId, reference.deploymentEpoch, reference.kind, reference.subject.kind, reference.subject.id, reference.generation, reference.inputHash,
  ])))), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function databaseNow(tx: Tx) {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  if (!clock) throw new ExecutionPageReceiptError("execution_page_receipt_invalid");
  return clock.now;
}
async function read(tx: Tx, reference: ExecutionDispatchReference, audience: ExecutionPageAudience, hash: string, now: Date): Promise<ExecutionPageOutcome | null> {
  const prior = await tx.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience, deliveryId: reference.dispatchId } } });
  if (prior) {
    if (prior.requestHash !== hash || prior.keyId !== "internal-maintenance") throw new ExecutionPageReceiptError("execution_page_receipt_invalid");
    if (prior.expiresAt <= now) throw new ExecutionPageReceiptError("execution_page_expired");
    return parse(prior.disposition, prior.wakeDispatchIds);
  }
  const dispatch = await tx.executionDispatch.findUniqueOrThrow({ where: { id: reference.dispatchId }, select: { createdAt: true, dueAt: true } });
  if (Math.max(dispatch.createdAt.getTime(), dispatch.dueAt.getTime()) + RETENTION_MS <= now.getTime()) throw new ExecutionPageReceiptError("execution_page_expired");
  return null;
}
/** Read-only operator proof, after the owning service has validated the exact
 * current ledger/source pair. Missing receipts grant no replay permission. */
export async function readExecutionPageReceipt(tx: Tx, reference: ExecutionDispatchReference, audience: ExecutionPageAudience) {
  return read(tx, reference, audience, await requestHash(reference, audience), await databaseNow(tx));
}
/** The caller validates the exact ledger tuple/current epoch first. Its page
 * mutation and complete wake list then commit once under this internal receipt.
 * No signed external audience can address these receipt namespaces. */
export async function executeExecutionPage(tx: Tx, reference: ExecutionDispatchReference, audience: ExecutionPageAudience, operation: () => Promise<ExecutionPageOutcome>): Promise<ExecutionPageOutcome> {
  const hash = await requestHash(reference, audience), lock = `executor-inbox:${audience}:${reference.dispatchId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0)) IS NULL AS locked`;
  const now = await databaseNow(tx), prior = await read(tx, reference, audience, hash, now);
  if (prior) return prior;
  const outcome = await operation(), result = parse({ kind: outcome.kind, processed: outcome.processed }, outcome.dispatchIds);
  await tx.executionInboxReceipt.create({ data: { audience, deliveryId: reference.dispatchId, keyId: "internal-maintenance", requestHash: hash,
    disposition: { kind: result.kind, processed: result.processed }, wakeDispatchIds: result.dispatchIds, committedAt: now, expiresAt: new Date(now.getTime() + RETENTION_MS) } });
  return result;
}
