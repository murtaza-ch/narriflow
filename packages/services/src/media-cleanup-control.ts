import type { ExecutionDispatch, MediaCleanupObligation, Prisma, PrismaClient } from "@prisma/client";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, appendExecutionDispatches, readExecutionDispatch } from "./execution-dispatch";
import { readExecutionAdmission } from "./execution-admission";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { MEDIA_CLEANUP_CLASSES, MEDIA_CLEANUP_ORIGINS } from "./media-cleanup-contract";

const LEASE_MS = 120_000;
export const MEDIA_CLEANUP_HTTP_TIMEOUT_MS = 30_000;
type Tx = Prisma.TransactionClient;
export class MediaCleanupControlError extends Error {
  constructor(readonly code: "cleanup_reference_invalid" | "cleanup_intent_invalid" | "cleanup_clock_unavailable") { super(code); }
}
export type MediaCleanupResult =
  | { kind: "complete" | "superseded"; dispatchIds: string[] }
  | { kind: "wait" | "retry"; until: Date; dispatchIds: string[] };
export interface MediaCleanupStorage { deleteExact(storageKey: string, options: { signal: AbortSignal }): Promise<void> }
export type MediaCleanupHold = (tx: Tx, intent: Readonly<MediaCleanupObligation>, now: Date) => Promise<Date | null>;

async function clock(tx: Tx) {
  const [value] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  if (!value) throw new MediaCleanupControlError("cleanup_clock_unavailable");
  return value.now;
}
function validateIntent(row: MediaCleanupObligation) {
  if (!(MEDIA_CLEANUP_ORIGINS as readonly string[]).includes(row.origin) || !(MEDIA_CLEANUP_CLASSES as readonly string[]).includes(row.cleanupClass) ||
    !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,1023}$/.test(row.objectKey) || row.objectKey.split("/").some(part => !part || part === "." || part === "..")) throw new MediaCleanupControlError("cleanup_intent_invalid");
}
async function lockIntent(tx: Tx, id: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new MediaCleanupControlError("cleanup_reference_invalid");
  const [row] = await tx.$queryRaw<MediaCleanupObligation[]>`SELECT * FROM "MediaCleanupObligation" WHERE id = ${id}::uuid FOR UPDATE`;
  if (row) validateIntent(row);
  return row;
}
async function inputHash(row: MediaCleanupObligation) {
  const fields = ["media-cleanup-v1", row.id, row.origin, row.cleanupClass, row.objectKey, row.projectId, row.clipId, row.createdAt.toISOString()];
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(fields)))), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function latest(tx: Tx, epoch: number, id: string) {
  const [row] = await tx.$queryRaw<ExecutionDispatch[]>`SELECT * FROM "ExecutionDispatch" WHERE "deploymentEpoch" = ${epoch}
    AND kind = 'operation_driver' AND "subjectKind" = 'media_cleanup' AND "subjectId" = ${id} AND "wakeKind" IS NULL AND "deadlineKind" IS NULL ORDER BY generation DESC LIMIT 1`;
  return row ?? null;
}
async function append(tx: Tx, epoch: number, row: MediaCleanupObligation): Promise<ExecutionDispatchReference> {
  const previous = await latest(tx, epoch, row.id), hash = await inputHash(row);
  if (previous?.inputHash === hash && previous.dueAt.getTime() === row.nextAttemptAt.getTime()) {
    collectExecutionDispatch(tx, previous.id);
    return (await readExecutionDispatch(tx, previous.id))!.reference;
  }
  const record = await appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: (previous?.generation ?? 0) + 1, kind: "operation_driver", subject: { kind: "media_cleanup", id: row.id }, inputHash: hash, dueAt: row.nextAttemptAt });
  collectExecutionDispatch(tx, record.reference.dispatchId);
  return record.reference;
}
/** Producer calls this in the transaction that admitted or rescheduled the
 * exact intent. Replay confirms the existing registration with no new due time. */
export async function queueMediaCleanupWithinTransaction(tx: Tx, id: string): Promise<ExecutionDispatchReference | null> {
  const epoch = await tx.executionEpoch.findUnique({ where: { id: 1 }, select: { epoch: true } });
  if (!epoch) throw new MediaCleanupControlError("cleanup_clock_unavailable");
  const row = await lockIntent(tx, id);
  return row && !row.completedAt ? append(tx, epoch.epoch, row) : null;
}

/** Fixed SQL round trips for a bounded range page. Cleanup and tentative
 * adopters both lock destinations in bytewise key order to avoid lock cycles. */
export async function queueMediaCleanupBatchWithinTransaction(tx: Tx, ids: readonly string[]): Promise<ExecutionDispatchReference[]> {
  if (ids.length > 100 || ids.some(id => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) throw new MediaCleanupControlError("cleanup_intent_invalid");
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const epoch = await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 }, select: { epoch: true } });
  const rows = await tx.$queryRaw<MediaCleanupObligation[]>`SELECT * FROM "MediaCleanupObligation" WHERE id = ANY(${unique}::uuid[]) AND "completedAt" IS NULL
    ORDER BY "objectKey" COLLATE "C", origin COLLATE "C", "cleanupClass" COLLATE "C", id FOR UPDATE`;
  const previous = await tx.$queryRaw<ExecutionDispatch[]>`SELECT base.* FROM unnest(${rows.map(row => row.id)}::text[]) AS subject(id)
    CROSS JOIN LATERAL (SELECT * FROM "ExecutionDispatch" WHERE "deploymentEpoch" = ${epoch.epoch} AND "subjectId" = subject.id
      AND kind = 'operation_driver' AND "subjectKind" = 'media_cleanup' AND "wakeKind" IS NULL AND "deadlineKind" IS NULL ORDER BY generation DESC LIMIT 1) AS base`;
  const latestRows = new Map(previous.map(row => [row.subjectId, row])), result = new Map<string, ExecutionDispatchReference>();
  const fresh = await Promise.all(rows.map(async row => {
    validateIntent(row);
    const old = latestRows.get(row.id), hash = await inputHash(row);
    if (old?.inputHash === hash && old.dueAt.getTime() === row.nextAttemptAt.getTime()) {
      result.set(row.id, executionDispatchReferenceSchema.parse({ dispatchId: old.id, deploymentEpoch: old.deploymentEpoch, generation: old.generation, kind: old.kind,
        subject: { kind: old.subjectKind, id: old.subjectId }, inputHash: old.inputHash }));
      return null;
    }
    return { deploymentEpoch: epoch.epoch, generation: (old?.generation ?? 0) + 1, kind: "operation_driver" as const, subject: { kind: "media_cleanup" as const, id: row.id }, inputHash: hash, dueAt: row.nextAttemptAt };
  }));
  for (const record of await appendExecutionDispatches(tx, fresh.filter(value => value !== null))) result.set(record.reference.subject.id, record.reference);
  const references = unique.flatMap(id => { const reference = result.get(id); return reference ? [reference] : []; });
  for (const reference of references) collectExecutionDispatch(tx, reference.dispatchId);
  return references;
}

/** One exact fixed-origin HTTP delete, with no connection held across HTTP.
 * The hold port performs only authoritative indexed database reads. */
export function createMediaCleanupControl(options: { database: PrismaClient; register(ids: readonly string[]): Promise<void>; hold: MediaCleanupHold; storage: MediaCleanupStorage }) {
  async function run(value: ExecutionDispatchReference): Promise<MediaCleanupResult> {
    const parsed = executionDispatchReferenceSchema.safeParse(value);
    if (!parsed.success) throw new MediaCleanupControlError("cleanup_reference_invalid");
    const reference = parsed.data;
    const prepared = await options.database.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx);
      const record = await readExecutionDispatch(tx, reference.dispatchId);
      if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference) || reference.kind !== "operation_driver" || reference.subject.kind !== "media_cleanup") throw new MediaCleanupControlError("cleanup_reference_invalid");
      if (epoch !== reference.deploymentEpoch) return { result: { kind: "superseded" as const, dispatchIds: [] } };
      const row = await lockIntent(tx, reference.subject.id);
      if (!row) return { result: { kind: "complete" as const, dispatchIds: [] } };
      const base = await latest(tx, epoch, row.id);
      if (!base || reference.inputHash !== await inputHash(row)) return { result: { kind: "superseded" as const, dispatchIds: [] } };
      if (row.completedAt) return { result: { kind: "complete" as const, dispatchIds: [] } };
      if (base.generation !== reference.generation) {
        // The retry committed even if its registration response was lost.
        // Old-reference replay repairs that existing obligation only.
        collectExecutionDispatch(tx, base.id);
        return { result: { kind: "superseded" as const, dispatchIds: [base.id] } };
      }
      if (base.dueAt.getTime() !== row.nextAttemptAt.getTime()) {
        const next = await append(tx, epoch, row);
        return { result: { kind: "retry" as const, until: row.nextAttemptAt, dispatchIds: [next.dispatchId] } };
      }
      const now = await clock(tx);
      if (row.claimId && row.claimExpiresAt && row.claimExpiresAt > now) {
        const timer = await appendExecutionDispatch(tx, { ...reference, dueAt: row.claimExpiresAt, wakeKind: "cleanup_claimed", deadlineKind: "lease", observedDeadlineAt: row.claimExpiresAt });
        collectExecutionDispatch(tx, timer.reference.dispatchId);
        return { result: { kind: "wait" as const, until: row.claimExpiresAt, dispatchIds: [timer.reference.dispatchId] } };
      }
      if (row.nextAttemptAt > now) return { result: { kind: "wait" as const, until: row.nextAttemptAt, dispatchIds: [] } };
      const claimId = crypto.randomUUID(), claimExpiresAt = new Date(now.getTime() + LEASE_MS);
      await tx.mediaCleanupObligation.update({ where: { id: row.id }, data: { claimId, claimExpiresAt, attemptCount: { increment: 1 } } });
      const heldUntil = await options.hold(tx, row, now);
      if (heldUntil) {
        if (!Number.isFinite(heldUntil.getTime()) || heldUntil <= now) throw new MediaCleanupControlError("cleanup_intent_invalid");
        const retained = await tx.mediaCleanupObligation.update({ where: { id: row.id }, data: { nextAttemptAt: heldUntil, claimId: null, claimExpiresAt: null, failureCode: "object_retained" } });
        const next = await append(tx, epoch, retained);
        return { result: { kind: "retry" as const, until: heldUntil, dispatchIds: [next.dispatchId] } };
      }
      const timer = await appendExecutionDispatch(tx, { ...reference, dueAt: claimExpiresAt, wakeKind: "cleanup_claimed", deadlineKind: "lease", observedDeadlineAt: claimExpiresAt });
      collectExecutionDispatch(tx, timer.reference.dispatchId);
      return { claim: { id: row.id, claimId, objectKey: row.objectKey, claimExpiresAt, attemptCount: row.attemptCount + 1 }, dispatchIds: [timer.reference.dispatchId] };
    });
    if (prepared.result) {
      if (prepared.result.dispatchIds.length) await options.register(prepared.result.dispatchIds);
      return prepared.result;
    }
    // A timer must be durably registered before the external operation. Lost
    // confirmation leaves this claim for its lease timer/hourly repair.
    await options.register(prepared.dispatchIds!);
    const claim = prepared.claim!;
    const allowed = await options.database.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx);
      if (epoch !== reference.deploymentEpoch) return false;
      const row = await lockIntent(tx, claim.id), now = await clock(tx);
      return Boolean(row && !row.completedAt && row.claimId === claim.claimId && row.claimExpiresAt && row.claimExpiresAt.getTime() > now.getTime() + MEDIA_CLEANUP_HTTP_TIMEOUT_MS);
    });
    if (!allowed) return { kind: "superseded", dispatchIds: [] };
    let acknowledged = false;
    try {
      await options.storage.deleteExact(claim.objectKey, { signal: AbortSignal.timeout(MEDIA_CLEANUP_HTTP_TIMEOUT_MS) });
      acknowledged = true;
    } catch { /* No response, permission errors and aborts all retain intent. */ }
    const result = await options.database.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx);
      if (epoch !== reference.deploymentEpoch) return { kind: "superseded" as const, dispatchIds: [] };
      const row = await lockIntent(tx, claim.id), now = await clock(tx);
      if (!row || row.claimId !== claim.claimId || row.completedAt || !row.claimExpiresAt || row.claimExpiresAt <= now) return { kind: "superseded" as const, dispatchIds: [] };
      if (acknowledged) {
        await tx.mediaCleanupObligation.update({ where: { id: row.id }, data: { completedAt: now, claimId: null, claimExpiresAt: null, failureCode: null } });
        return { kind: "complete" as const, dispatchIds: [] };
      }
      const until = new Date(now.getTime() + Math.min(5_000 * 2 ** Math.min(claim.attemptCount - 1, 20), 21_600_000));
      const retry = await tx.mediaCleanupObligation.update({ where: { id: row.id }, data: { nextAttemptAt: until, claimId: null, claimExpiresAt: null, failureCode: "storage_delete_unconfirmed" } });
      return { kind: "retry" as const, until, dispatchIds: [(await append(tx, epoch, retry)).dispatchId] };
    });
    if (result.dispatchIds.length) await options.register(result.dispatchIds);
    return result;
  }
  return { run };
}
