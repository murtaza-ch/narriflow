import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type Transcript } from "@prisma/client";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { readExecutionAdmission } from "./execution-admission";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { lockWorkspaceUsage } from "./processing-usage";
import { accessibleProjectWhere } from "./project-access";
import { chunkUtterances } from "./library-passages";
import { planEmbeddingBatches, type EmbeddingBatchLimits } from "./library-embedding-batches";
import { EmbeddingProviderError, LIBRARY_EMBEDDING_MODEL, LIBRARY_EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "./openai-embedding-provider";

type Tx = Prisma.TransactionClient;
export const MAX_INDEX_ATTEMPTS = 8;
const LEASE_MS = 60_000, DEADLINE_MS = 45 * 60_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function sourceHash(row: Transcript) { return hash(["library-source-v1", row.id, row.completedAt?.toISOString(), row.selectionGeneration, row.utterancesJson, LIBRARY_EMBEDDING_MODEL]); }
function inputHash(row: Transcript) { return hash(["library-index-v1", row.id, row.passagesEpoch, row.passagesGeneration, row.passagesSourceHash, row.passagesRetryAt?.toISOString(), row.passagesDeadlineAt?.toISOString()]); }
async function databaseNow(tx: Tx) {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  if (!clock) throw Error("library_clock_unavailable");
  return clock.now;
}
async function lock(tx: Tx, id: string) {
  const { epoch } = await readExecutionAdmission(tx);
  const initial = await tx.transcript.findUnique({ where: { id }, select: { projectId: true, project: { select: { workspaceId: true } } } });
  if (!initial) return null;
  await lockWorkspaceUsage(tx, initial.project.workspaceId);
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${initial.projectId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Transcript" WHERE id=${id}::uuid FOR UPDATE`;
  const now = await databaseNow(tx);
  const project = await tx.project.findFirst({ where: { id: initial.projectId, ...accessibleProjectWhere(now), workspace: { status: "active" } }, select: { workspaceId: true } });
  const row = await tx.transcript.findUnique({ where: { id } });
  if (!project || !row || row.status !== "completed" || !row.completedAt || row.utterancesJson === null) return null;
  return { row, epoch, now, workspaceId: project.workspaceId };
}
async function append(tx: Tx, row: Transcript) {
  if (!row.passagesRetryAt || !row.passagesSourceHash || !row.passagesDeadlineAt) return null;
  const record = await appendExecutionDispatch(tx, { deploymentEpoch: row.passagesEpoch, generation: row.passagesGeneration,
    kind: "operation_driver", subject: { kind: "library_index", id: row.id }, inputHash: inputHash(row), dueAt: row.passagesRetryAt });
  collectExecutionDispatch(tx, record.reference.dispatchId);
  return record.reference;
}

/** Transcript completion and its indexing obligation share the owning transaction.
 * An unchanged receipt repairs registration without resetting charges or deadlines. */
export async function queueLibraryIndex(tx: Tx, id: string, options?: { deferDispatch: true }): Promise<ExecutionDispatchReference | null> {
  if (options?.deferDispatch && (await readExecutionAdmission(tx)).admissionOpen) throw Error("library_restore_requires_closed_admission");
  const state = await lock(tx, id);
  if (!state) return null;
  const { row, epoch, now } = state, fingerprint = sourceHash(row), changed = fingerprint !== row.passagesSourceHash;
  if (options?.deferDispatch && (changed || row.passagesGeneration < 1 || !row.passagesDeadlineAt)) throw Error("library_restore_input_unavailable");
  if (!changed && row.passagesEpoch === epoch && row.passagesGeneration > 0) return options?.deferDispatch ? null : append(tx, row);
  const next = await tx.transcript.update({ where: { id }, data: { passagesEpoch: epoch, passagesGeneration: { increment: 1 }, passagesSourceHash: fingerprint,
    passagesClaimId: null, passagesLeaseUntil: null, passagesRetryAt: changed ? now : row.passagesRetryAt,
    ...(changed ? { passagesAttempts: 0, passagesIndexError: null, passagesDeadlineAt: new Date(now.getTime() + DEADLINE_MS) } : {}) } });
  return options?.deferDispatch ? null : append(tx, next);
}

/** A completion receipt can repair a committed wake, but cannot admit indexing
 * for a different transcript or change its retry budget. */
export async function recoverLibraryIndex(tx: Tx, id: string): Promise<ExecutionDispatchReference | null> {
  const state = await lock(tx,id);
  if (!state || state.row.passagesEpoch !== state.epoch || state.row.passagesGeneration < 1 || state.row.passagesSourceHash !== sourceHash(state.row)) return null;
  return append(tx,state.row);
}

export type LibraryIndexResult = { kind: "complete" | "superseded" } | { kind: "sleep" | "wait" | "retry"; dueAt: Date };

/** One exact transcript and at most one provider batch per command. Every
 * committed batch survives retries. There is no SQL transaction over provider I/O. */
export function createLibraryIndex(options: { database: PrismaClient; embeddings: EmbeddingProvider;
  register(ids: readonly string[]): Promise<void>; batch?: EmbeddingBatchLimits; retryBaseMs?: number; log?(entry: Record<string, unknown>): void }) {
  const { database: db, embeddings } = options;
  if (embeddings.model !== LIBRARY_EMBEDDING_MODEL) throw Error("library_model_invalid");
  const retryBaseMs = options.retryBaseMs ?? 30_000;
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 0 || retryBaseMs > 60_000) throw Error("library_retry_invalid");
  async function owned(tx: Tx, reference: ExecutionDispatchReference, claimId?: string) {
    if (reference.kind !== "operation_driver" || reference.subject.kind !== "library_index") return null;
    const record = await readExecutionDispatch(tx, reference.dispatchId);
    if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference)) return null;
    const state = await lock(tx, reference.subject.id);
    if (!state || reference.deploymentEpoch !== state.epoch ||
      state.row.passagesEpoch !== state.epoch || state.row.passagesGeneration !== reference.generation || sourceHash(state.row) !== state.row.passagesSourceHash || inputHash(state.row) !== reference.inputHash) return null;
    if (claimId && (state.row.passagesClaimId !== claimId || !state.row.passagesLeaseUntil || state.row.passagesLeaseUntil <= state.now || !state.row.passagesDeadlineAt || state.row.passagesDeadlineAt <= state.now)) return null;
    return state;
  }
  return { async run(value: ExecutionDispatchReference): Promise<LibraryIndexResult> {
    const reference = executionDispatchReferenceSchema.parse(value);
    const prepared = await db.$transaction(async tx => {
      const state = await owned(tx, reference);
      if (!state) return { kind: "superseded" as const };
      const { row, now } = state;
      if (!row.passagesRetryAt) return { kind: "complete" as const };
      if (!row.passagesDeadlineAt || row.passagesDeadlineAt <= now || row.passagesAttempts >= MAX_INDEX_ATTEMPTS) {
        await tx.transcript.update({ where: { id: row.id }, data: { passagesRetryAt: null, passagesClaimId: null, passagesLeaseUntil: null,
          passagesIndexError: row.passagesAttempts >= MAX_INDEX_ATTEMPTS ? row.passagesIndexError : "library_index_deadline_exceeded" } });
        return { kind: "complete" as const };
      }
      if (row.passagesRetryAt > now) return { kind: "sleep" as const, dueAt: row.passagesRetryAt };
      if (row.passagesClaimId && row.passagesLeaseUntil && row.passagesLeaseUntil > now) return { kind: "wait" as const, dueAt: row.passagesLeaseUntil };
      if (!embeddings.configured) {
        await tx.transcript.update({ where: { id: row.id }, data: { passagesIndexError: "embedding_not_configured", passagesRetryAt: null, passagesClaimId: null, passagesLeaseUntil: null } });
        return { kind: "complete" as const };
      }
      const utterances = Array.isArray(row.utterancesJson) ? row.utterancesJson.flatMap(value => {
        const item = value as { startSec?: unknown; endSec?: unknown; text?: unknown } | null;
        return item && typeof item.startSec === "number" && typeof item.endSec === "number" && typeof item.text === "string" ? [{ startSec: item.startSec, endSec: item.endSec, text: item.text }] : [];
      }) : [];
      const drafts = [...new Map(chunkUtterances(utterances).map(draft => [draft.contentHash, draft])).values()];
      const existing = await tx.$queryRaw<Array<{ contentHash: string }>>`SELECT "contentHash" FROM "TranscriptPassage" WHERE "transcriptId"=${row.id}::uuid AND "embeddingModel"=${embeddings.model}`;
      const known = new Set(existing.map(item => item.contentHash)), fresh = drafts.filter(draft => !known.has(draft.contentHash));
      if (!fresh.length) {
        await tx.$executeRaw`DELETE FROM "TranscriptPassage" WHERE "transcriptId"=${row.id}::uuid AND "contentHash" <> ALL(${drafts.map(draft => draft.contentHash)}::text[])`;
        await tx.transcript.update({ where: { id: row.id }, data: { passagesIndexedFor: row.completedAt, passagesAttempts: 0, passagesRetryAt: null, passagesIndexError: null, passagesClaimId: null, passagesLeaseUntil: null } });
        return { kind: "complete" as const };
      }
      const batch = planEmbeddingBatches(fresh, options.batch)[0]!;
      const lease = new Date(Math.min(now.getTime()+LEASE_MS, row.passagesDeadlineAt.getTime())), claimId = randomUUID();
      await tx.transcript.update({ where: { id: row.id }, data: { passagesClaimId: claimId, passagesLeaseUntil: lease, passagesAttempts: { increment: 1 } } });
      const watchdog = await appendExecutionDispatch(tx, { ...reference, subject: reference.subject, dueAt: lease, wakeKind: "library_lease", deadlineKind: "lease", observedDeadlineAt: lease });
      collectExecutionDispatch(tx, watchdog.reference.dispatchId);
      return { kind: "claimed" as const, batch, claimId, watchdogId: watchdog.reference.dispatchId, workspaceId: state.workspaceId, projectId: row.projectId, last: fresh.length === batch.length, hashes: drafts.map(draft => draft.contentHash) };
    });
    if (prepared.kind !== "claimed") {
      if (prepared.kind === "superseded" && reference.kind === "operation_driver" && reference.subject.kind === "library_index") {
        const current = await db.$transaction(async tx => {
          const { epoch } = await readExecutionAdmission(tx), record = await readExecutionDispatch(tx,reference.dispatchId);
          if (epoch !== reference.deploymentEpoch || !record || JSON.stringify(record.reference) !== JSON.stringify(reference)) return null;
          return recoverLibraryIndex(tx,reference.subject.id);
        });
        // This only redelivers an already committed current obligation. It
        // grants no new generation, lease, deadline or provider request.
        if (current) await options.register([current.dispatchId]);
      }
      return prepared;
    }
    try { await options.register([prepared.watchdogId]); }
    catch (error) {
      await db.$transaction(async tx => { const state = await owned(tx, reference, prepared.claimId); if (state) await tx.transcript.update({ where: { id: state.row.id }, data: { passagesClaimId: null, passagesLeaseUntil: null, passagesAttempts: { decrement: 1 } } }); });
      throw error;
    }
    // A revocation between registration and POST grants no provider authority.
    if (!await db.$transaction(tx => owned(tx, reference, prepared.claimId))) return { kind: "superseded" };
    let vectors: number[][], tokens = 0;
    try {
      const response = await embeddings.embed(prepared.batch.map(draft => draft.text));
      vectors = response.vectors; tokens = response.tokens;
      if (vectors.length !== prepared.batch.length || vectors.some(vector => vector.length !== LIBRARY_EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite))) throw new EmbeddingProviderError("embedding_bad_response");
    } catch (error) {
      const failure = await db.$transaction(async tx => {
        const state = await owned(tx, reference, prepared.claimId);
        if (!state) return null;
        const abandoned = state.row.passagesAttempts >= MAX_INDEX_ATTEMPTS;
        const dueAt = new Date(Math.min(state.now.getTime()+Math.min(retryBaseMs * 2 ** Math.max(0,state.row.passagesAttempts-1), 3_600_000), state.row.passagesDeadlineAt!.getTime()));
        const code = error instanceof EmbeddingProviderError ? error.code : "embedding_request_failed";
        const next = await tx.transcript.update({ where: { id: state.row.id }, data: { passagesGeneration: { increment: 1 }, passagesClaimId: null, passagesLeaseUntil: null,
          passagesIndexError: code, passagesRetryAt: abandoned ? null : dueAt } });
        return { reference: await append(tx, next), dueAt, abandoned, attempts: next.passagesAttempts, code };
      });
      if (!failure) return { kind: "superseded" };
      if (failure.reference) await options.register([failure.reference.dispatchId]);
      options.log?.({ level: failure.abandoned ? "error" : "warn", message: failure.abandoned ? "library_passages_index_abandoned" : "library_passages_index_failed", transcriptId: reference.subject.id, attempts: failure.attempts, code: failure.code, retryInSeconds: (failure.dueAt.getTime()-Date.now())/1000 });
      return failure.abandoned ? { kind: "complete" } : { kind: "retry", dueAt: failure.dueAt };
    }
    const committed = await db.$transaction(async tx => {
      const state = await owned(tx, reference, prepared.claimId);
      if (!state) return null;
      const rows = prepared.batch.map((draft,index) => Prisma.sql`(${randomUUID()}::uuid, ${prepared.workspaceId}::uuid, ${prepared.projectId}::uuid, ${state.row.id}::uuid,
        ${draft.startMs}::int, ${draft.endMs}::int, ${draft.text}, ${`[${vectors[index]!.join(",")}]`}::vector, ${embeddings.model}, ${draft.contentHash}, clock_timestamp() AT TIME ZONE 'UTC')`);
      await tx.$executeRaw`INSERT INTO "TranscriptPassage" (id,"workspaceId","projectId","transcriptId","startMs","endMs",text,embedding,"embeddingModel","contentHash","createdAt") VALUES ${Prisma.join(rows)}
        ON CONFLICT ("transcriptId","contentHash") DO UPDATE SET embedding=EXCLUDED.embedding,"embeddingModel"=EXCLUDED."embeddingModel"`;
      if (prepared.last) await tx.$executeRaw`DELETE FROM "TranscriptPassage" WHERE "transcriptId"=${state.row.id}::uuid AND "contentHash" <> ALL(${prepared.hashes}::text[])`;
      const next = await tx.transcript.update({ where: { id: state.row.id }, data: { passagesGeneration: { increment: 1 }, passagesClaimId: null, passagesLeaseUntil: null,
        passagesAttempts: 0, passagesIndexError: null, passagesRetryAt: prepared.last ? null : state.now, ...(prepared.last ? { passagesIndexedFor: state.row.completedAt } : {}) } });
      return { reference: await append(tx, next), tokens };
    });
    if (!committed) return { kind: "superseded" };
    if (committed.reference) await options.register([committed.reference.dispatchId]);
    options.log?.({ level: "info", message: "library_passages_indexed", transcriptId: reference.subject.id, projectId: prepared.projectId,
      workspaceId: prepared.workspaceId, passages: prepared.hashes.length, embedded: prepared.batch.length, tokens: committed.tokens, complete: prepared.last });
    return { kind: "complete" };
  } };
}
