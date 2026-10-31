import { Prisma, type ClipSelectionWindow, type PrismaClient, type Transcript } from "@prisma/client";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, executionDispatchIdentity, readExecutionDispatch } from "./execution-dispatch";
import { lockWorkspaceUsage } from "./processing-usage";
import { accessibleProjectWhere } from "./project-access";

type Tx = Prisma.TransactionClient;
const CAPACITY_LOCK = "provider_capacity:openai:clip_selection";
export const CLIP_SELECTION_CAPACITY_WAIT = "selection_capacity_wait";

export interface ClipSelectionObjectReference {
  storageKey: string;
  etag: string;
  sha256: string;
  byteLength: number;
}
export interface ClipSelectionWindowAttempt {
  reference: ExecutionDispatchReference;
  token: string;
  owner: string;
}
export type ClipSelectionWindowAdmission =
  | { kind: "begun"; attempt: ClipSelectionWindowAttempt; input: ClipSelectionObjectReference; windowIndex: number; operationDeadlineAt: Date; leaseExpiresAt: Date; dispatchIds: string[] }
  | { kind: "wait"; dueAt: Date; dispatchIds: string[] }
  | { kind: "completed" | "failed" | "cancelled" | "superseded"; dispatchIds: string[] };
export type ClipSelectionWindowSettlement = { kind: "completed" | "retried" | "failed" | "cancelled" | "superseded"; dispatchIds: string[] };

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A content replacement with unchanged provider lineage still invalidates selection. */
export function clipSelectionTranscriptHash(transcript: Pick<Transcript, "text" | "utterancesJson" | "speakerCount" | "languageCode" | "selectionGeneration" | "workflowAttemptId" | "sourceAudioId" | "sourceRevision">): Promise<string> {
  return sha256(JSON.stringify({ text: transcript.text, utterances: transcript.utterancesJson, speakerCount: transcript.speakerCount,
    languageCode: transcript.languageCode, generation: transcript.selectionGeneration, attemptId: transcript.workflowAttemptId,
    sourceAudioId: transcript.sourceAudioId, sourceRevision: transcript.sourceRevision }));
}

async function clock(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  if (!row) throw new Error("Database clock unavailable");
  return row.now;
}
function sameReference(left: ExecutionDispatchReference, right: ExecutionDispatchReference): boolean {
  return left.dispatchId === right.dispatchId && left.kind === right.kind && left.subject.kind === right.subject.kind && left.subject.id === right.subject.id &&
    left.generation === right.generation && left.deploymentEpoch === right.deploymentEpoch && left.inputHash === right.inputHash;
}
function uuid(value: string): boolean { return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value); }

async function lockWindow(tx: Tx, value: ExecutionDispatchReference, historicalResult = false): Promise<{ row: ClipSelectionWindow; now: Date } | null> {
  const parsed = executionDispatchReferenceSchema.safeParse(value);
  if (!parsed.success || value.kind !== "operation_driver" || value.subject.kind !== "clip_selection_window") return null;
  const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE id = 1 FOR SHARE`;
  const registered = await readExecutionDispatch(tx, value.dispatchId);
  if (epoch?.epoch !== value.deploymentEpoch || !registered || !sameReference(registered.reference, value)) return null;
  const initial = await tx.clipSelectionWindow.findUnique({ where: { id: value.subject.id }, include: { workflowRun: { include: { project: { select: { workspaceId: true } } } } } });
  if (!initial) return null;
  await lockWorkspaceUsage(tx, initial.workflowRun.project.workspaceId);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${initial.projectId}, 0)) IS NULL AS "locked"`;
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${initial.projectId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id = ${initial.workflowRunId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "ClipSelectionWindow" WHERE id = ${initial.id}::uuid FOR UPDATE`;
  const row = await tx.clipSelectionWindow.findUniqueOrThrow({ where: { id: initial.id } }), now = await clock(tx);
  if (row.deploymentEpoch !== value.deploymentEpoch || row.generation !== value.generation || row.inputHash !== value.inputHash) return null;
  if (historicalResult && row.status === "completed") return { row, now };
  const parent = await tx.workflowRun.findUniqueOrThrow({ where: { id: row.workflowRunId } });
  const project = await tx.project.findFirst({ where: { id: row.projectId, ...accessibleProjectWhere(now), ingestStatus: { not: "failed" }, workspace: { status: "active" } } });
  const transcript = await tx.transcript.findUnique({ where: { projectId: row.projectId }, include: { sourceAudio: { select: { bindingHash: true } } } });
  if (!project || !transcript || parent.stage !== "moment_detection" || parent.status !== "waiting" || parent.attemptId || parent.leaseOwner || parent.leaseExpiresAt ||
    parent.deploymentEpoch !== row.deploymentEpoch || parent.generation !== row.workflowGeneration || transcript.status !== "completed" ||
    project.sourceRevision !== row.sourceRevision || transcript.sourceRevision !== row.sourceRevision || transcript.id !== row.transcriptId ||
    transcript.selectionGeneration !== row.transcriptGeneration || transcript.workflowAttemptId !== row.transcriptAttemptId ||
    transcript.sourceAudioId !== row.sourceAudioId || (transcript.sourceAudio?.bindingHash ?? null) !== row.sourceAudioBindingHash ||
    await clipSelectionTranscriptHash(transcript) !== row.transcriptContentHash) return null;
  return { row, now };
}

async function dispatchWindow(tx: Tx, row: ClipSelectionWindow): Promise<ExecutionDispatchReference> {
  const identity = { deploymentEpoch: row.deploymentEpoch, kind: "operation_driver" as const, subject: { kind: "clip_selection_window" as const, id: row.id }, generation: row.generation };
  const key = await executionDispatchIdentity(identity);
  const existing = await tx.executionDispatch.findUnique({ where: { deliveryKey: key.deliveryKey }, select: { dueAt: true } });
  return (await appendExecutionDispatch(tx, { ...identity, inputHash: row.inputHash, dueAt: existing?.dueAt ?? row.retryAt ?? row.createdAt })).reference;
}
async function parentWake(tx: Tx, row: ClipSelectionWindow): Promise<string> {
  const registration = await tx.executionDispatch.findFirstOrThrow({ where: { subjectKind: "workflow_run", subjectId: row.workflowRunId, kind: "operation_driver",
    deploymentEpoch: row.deploymentEpoch, generation: row.workflowGeneration, wakeKind: null, deadlineKind: null }, orderBy: { createdAt: "asc" } });
  return (await appendExecutionDispatch(tx, { deploymentEpoch: row.deploymentEpoch, kind: "operation_driver", subject: { kind: "workflow_run", id: row.workflowRunId },
    generation: row.workflowGeneration, inputHash: registration.inputHash, dueAt: row.completedAt ?? row.updatedAt, wakeKind: `sel_${row.id.replaceAll("-", "")}` })).reference.dispatchId;
}
async function leaseWake(tx: Tx, row: ClipSelectionWindow, reference: ExecutionDispatchReference): Promise<string> {
  if (!row.leaseExpiresAt) throw new Error("Selection lease missing");
  return (await appendExecutionDispatch(tx, { ...reference, subject: reference.subject, dueAt: row.leaseExpiresAt,
    wakeKind: "selection_lease", deadlineKind: "lease", observedDeadlineAt: row.leaseExpiresAt })).reference.dispatchId;
}

/** A replay can recover obligations committed by its former owner, never new authority. */
async function replayWakes(tx: Tx, reference: ExecutionDispatchReference): Promise<string[]> {
  const parsed = executionDispatchReferenceSchema.safeParse(reference);
  if (!parsed.success || reference.kind !== "operation_driver" || reference.subject.kind !== "clip_selection_window") return [];
  const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE id = 1 FOR SHARE`;
  const registered = await readExecutionDispatch(tx, reference.dispatchId);
  if (epoch?.epoch !== reference.deploymentEpoch || !registered || !sameReference(registered.reference, reference)) return [];
  const row = await tx.clipSelectionWindow.findUnique({ where: { id: reference.subject.id } });
  if (!row || row.deploymentEpoch !== reference.deploymentEpoch || row.inputHash !== reference.inputHash || row.generation < reference.generation) return [];
  if (["completed", "failed", "cancelled"].includes(row.status)) return [await parentWake(tx, row)];
  if (row.generation > reference.generation) return [(await dispatchWindow(tx, row)).dispatchId];
  return row.status === "running" ? [await leaseWake(tx, row, reference)] : [];
}

/** No other Project or window row is locked while holding this account lock. */
async function capacity(tx: Tx, deploymentEpoch: number, now: Date) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK}, 0)) IS NULL AS "locked"`;
  const current = Prisma.sql`run.status = 'waiting' AND run.generation = w."workflowGeneration" AND run."deploymentEpoch" = w."deploymentEpoch"
    AND run."attemptId" IS NULL AND run."leaseOwner" IS NULL AND run."leaseExpiresAt" IS NULL
    AND p."ingestStatus" <> 'failed' AND p."sourceRevision" = w."sourceRevision" AND p."purgeStartedAt" IS NULL
    AND (p."expiresAt" IS NULL OR p."expiresAt" > (${now}::timestamptz AT TIME ZONE 'UTC')) AND workspace.status = 'active'
    AND transcript.status = 'completed' AND transcript.id = w."transcriptId" AND transcript."selectionGeneration" = w."transcriptGeneration"
    AND transcript."sourceRevision" = w."sourceRevision" AND transcript."workflowAttemptId" IS NOT DISTINCT FROM w."transcriptAttemptId"
    AND transcript."sourceAudioId" IS NOT DISTINCT FROM w."sourceAudioId"`;
  const [usage] = await tx.$queryRaw<Array<{ requests: number; tokens: number; dueAt: Date | null }>>`
    SELECT COUNT(*)::integer AS requests, COALESCE(SUM(w."estimatedTokens"), 0)::double precision AS tokens, MIN(w."leaseExpiresAt") AS "dueAt"
    FROM "ClipSelectionWindow" w JOIN "WorkflowRun" run ON run.id = w."workflowRunId" JOIN "Project" p ON p.id = w."projectId"
    JOIN "Transcript" transcript ON transcript."projectId" = p.id JOIN "Workspace" workspace ON workspace.id = p."workspaceId"
    WHERE w."deploymentEpoch" = ${deploymentEpoch} AND w.status = 'running' AND w."leaseExpiresAt" > (${now}::timestamptz AT TIME ZONE 'UTC')
      AND ${current}
  `;
  if (!usage) throw new Error("Selection capacity unavailable");
  // A Project takes one turn at a time. Its next turn sorts after every Project
  // that has not started since, independent of the number of queued windows.
  const [head] = await tx.$queryRaw<Array<{ id: string; operationDeadlineAt: Date }>>`
    SELECT w.id, w."operationDeadlineAt" FROM "ClipSelectionWindow" w
    JOIN "WorkflowRun" run ON run.id = w."workflowRunId" JOIN "Project" p ON p.id = w."projectId"
    JOIN "Transcript" transcript ON transcript."projectId" = p.id JOIN "Workspace" workspace ON workspace.id = p."workspaceId"
    WHERE w."deploymentEpoch" = ${deploymentEpoch} AND w.status = 'queued' AND (w."retryAt" IS NULL OR w."retryAt" <= (${now}::timestamptz AT TIME ZONE 'UTC') OR w."errorCode" = ${CLIP_SELECTION_CAPACITY_WAIT})
      AND w."operationDeadlineAt" > (${now}::timestamptz AT TIME ZONE 'UTC') AND ${current}
    ORDER BY (SELECT MAX(turn."lastProviderStartedAt") FROM "ClipSelectionWindow" turn WHERE turn."projectId" = w."projectId" AND turn."deploymentEpoch" = w."deploymentEpoch") ASC NULLS FIRST,
      w."providerQueuedAt" ASC, w.id ASC LIMIT 1
  `;
  return { ...usage, head };
}
async function wakeHead(tx: Tx, deploymentEpoch: number, cause: string, now: Date): Promise<string[]> {
  const { head } = await capacity(tx, deploymentEpoch, now);
  if (!head) return [];
  const row = await tx.clipSelectionWindow.findUniqueOrThrow({ where: { id: head.id } });
  const reference = await dispatchWindow(tx, row);
  // Epoch zero is a stable due time for replay of this exact release hint.
  const wake = await appendExecutionDispatch(tx, { ...reference, subject: reference.subject, dueAt: new Date(0), wakeKind: `sel_${cause.replaceAll("-", "")}` });
  return [wake.reference.dispatchId];
}

export function clipSelectionWindowResultKey(attempt: ClipSelectionWindowAttempt, sha: string): string {
  if (!uuid(attempt.token) || !uuid(attempt.owner) || !/^[a-f0-9]{64}$/.test(sha)) throw new Error("Invalid selection result identity");
  return `execution/${attempt.reference.deploymentEpoch}/clip_selection_window/${attempt.reference.subject.id}/${attempt.reference.generation}/${attempt.token}/${attempt.owner}/selection_window/${sha}.json`;
}

/** Short authoritative commands. Provider and storage I/O never run under locks. */
export function createClipSelectionLifecycle(config: { database: PrismaClient; maxInFlightRequests: number; maxEstimatedTokens: number }) {
  if (!Number.isSafeInteger(config.maxInFlightRequests) || config.maxInFlightRequests <= 0 || !Number.isSafeInteger(config.maxEstimatedTokens) || config.maxEstimatedTokens <= 0) throw new RangeError("Explicit selection provider request and token limits are required");
  const transaction = <T>(body: (tx: Tx) => Promise<T>) => config.database.$transaction(body, { maxWait: 10_000, timeout: 30_000 });

  async function finish(tx: Tx, row: ClipSelectionWindow, now: Date, input: { failureCode: string; dueAt?: Date }): Promise<ClipSelectionWindowSettlement> {
    await capacity(tx, row.deploymentEpoch, now);
    if (row.attemptToken) {
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${row.attemptToken}::uuid FOR UPDATE`;
      await tx.executionAttempt.updateMany({ where: { attemptToken: row.attemptToken, status: { in: ["admitted", "running"] } },
        data: { status: "failed", failureCode: input.failureCode, revokedAt: now, finishedAt: now } });
    }
    const retryAt = input.dueAt ? new Date(Math.min(Math.max(now.getTime(), input.dueAt.getTime()), row.operationDeadlineAt.getTime())) : null;
    const retry = row.status === "running" && retryAt !== null && retryAt < row.operationDeadlineAt && row.attemptCount < row.maxAttempts;
    const next = await tx.clipSelectionWindow.update({ where: { id: row.id }, data: retry
      ? { status: "queued", generation: { increment: 1 }, attemptToken: null, executorOwner: null, leaseExpiresAt: null, retryAt, errorCode: input.failureCode }
      : { status: "failed", leaseExpiresAt: null, errorCode: input.failureCode, completedAt: now } });
    const dispatchIds = retry ? [(await dispatchWindow(tx, next)).dispatchId] : [await parentWake(tx, next)];
    dispatchIds.push(...await wakeHead(tx, row.deploymentEpoch, row.attemptToken ?? row.id, now));
    return { kind: retry ? "retried" : "failed", dispatchIds };
  }

  return {
    async admit(reference: ExecutionDispatchReference, invocation: { owner: string }): Promise<ClipSelectionWindowAdmission> {
      if (!uuid(invocation.owner)) throw new Error("Invalid selection invocation owner");
      return transaction(async tx => {
        const state = await lockWindow(tx, reference, true);
        if (!state) return { kind: "superseded", dispatchIds: await replayWakes(tx, reference) };
        const { row, now } = state;
        if (["completed", "failed", "cancelled"].includes(row.status)) return { kind: row.status as "completed" | "failed" | "cancelled", dispatchIds: [await parentWake(tx, row)] };
        if (row.operationDeadlineAt <= now) return { ...await finish(tx, row, now, { failureCode: "operation_deadline_exceeded" }), kind: "failed" };
        if (row.status === "running") {
          if (row.leaseExpiresAt! <= now) {
            const expired = await finish(tx, row, now, { failureCode: "executor_lease_expired", dueAt: now });
            return { kind: "superseded", dispatchIds: expired.dispatchIds };
          }
          return { kind: "wait", dueAt: row.leaseExpiresAt!, dispatchIds: [await leaseWake(tx, row, reference)] };
        }
        if (row.attemptCount >= row.maxAttempts) return { ...await finish(tx, row, now, { failureCode: "selection_attempts_exhausted" }), kind: "failed" };
        if (row.retryAt && row.retryAt > now && row.errorCode !== CLIP_SELECTION_CAPACITY_WAIT) return { kind: "wait", dueAt: row.retryAt, dispatchIds: [] };
        if (row.estimatedTokens > config.maxEstimatedTokens) throw new RangeError("Selection token cap cannot admit this window");
        const used = await capacity(tx, row.deploymentEpoch, now);
        if (used.head?.id !== row.id || used.requests >= config.maxInFlightRequests || used.tokens + row.estimatedTokens > config.maxEstimatedTokens) {
          const dueAt = new Date(Math.min(row.operationDeadlineAt.getTime(), used.dueAt?.getTime() ?? used.head?.operationDeadlineAt.getTime() ?? row.operationDeadlineAt.getTime()));
          await tx.clipSelectionWindow.update({ where: { id: row.id }, data: { errorCode: CLIP_SELECTION_CAPACITY_WAIT, retryAt: dueAt } });
          const dispatchIds = used.head && used.head.id !== row.id && used.requests < config.maxInFlightRequests && used.tokens < config.maxEstimatedTokens
            ? await wakeHead(tx, row.deploymentEpoch, row.id, now) : [];
          return { kind: "wait", dueAt, dispatchIds };
        }
        const token = crypto.randomUUID(), leaseExpiresAt = new Date(Math.min(now.getTime() + 120_000, row.operationDeadlineAt.getTime()));
        await tx.executionAttempt.create({ data: { attemptToken: token, dispatchId: reference.dispatchId, deploymentEpoch: row.deploymentEpoch, generation: row.generation,
          inputHash: row.inputHash, functionName: "clip_selection_window", inputStorageKey: row.inputStorageKey, inputEtag: row.inputEtag, inputByteLength: row.inputByteLength,
          inputChecksumSha256: row.inputChecksumSha256, owner: invocation.owner, leaseExpiresAt, operationDeadlineAt: row.operationDeadlineAt, status: "running", processStartedAt: now } });
        await tx.clipSelectionWindow.update({ where: { id: row.id }, data: { status: "running", attemptToken: token, executorOwner: invocation.owner, leaseExpiresAt,
          attemptCount: { increment: 1 }, lastProviderStartedAt: now, errorCode: null, retryAt: null } });
        const dispatchIds = [await leaseWake(tx, { ...row, leaseExpiresAt }, reference), ...await wakeHead(tx, row.deploymentEpoch, token, now)];
        return { kind: "begun", attempt: { reference, token, owner: invocation.owner }, input: { storageKey: row.inputStorageKey, etag: row.inputEtag,
          sha256: row.inputChecksumSha256, byteLength: Number(row.inputByteLength) }, windowIndex: row.windowIndex, operationDeadlineAt: row.operationDeadlineAt, leaseExpiresAt, dispatchIds };
      });
    },
    async complete(attempt: ClipSelectionWindowAttempt, result: ClipSelectionObjectReference & { tokensUsed: number; providerRequestId: string | null }): Promise<ClipSelectionWindowSettlement> {
      if (result.storageKey !== clipSelectionWindowResultKey(attempt, result.sha256) || !/^"[^\r\n"]+"$/.test(result.etag) || !Number.isSafeInteger(result.byteLength) || result.byteLength < 1 || result.byteLength > 1_048_576 ||
        !Number.isSafeInteger(result.tokensUsed) || result.tokensUsed < 0 || (result.providerRequestId !== null && result.providerRequestId.length > 160)) throw new Error("Invalid selection result reference");
      return transaction(async tx => {
        const state = await lockWindow(tx, attempt.reference, true);
        if (!state) return { kind: "superseded", dispatchIds: await replayWakes(tx, attempt.reference) };
        const { row, now } = state;
        if (row.status === "completed") {
          if (row.attemptToken !== attempt.token || row.executorOwner !== attempt.owner || row.resultStorageKey !== result.storageKey || row.resultEtag !== result.etag || row.resultHash !== result.sha256 || row.resultByteLength !== BigInt(result.byteLength) ||
            row.tokensUsed !== result.tokensUsed || row.providerRequestId !== result.providerRequestId) throw new Error("Selection result receipt conflict");
          return { kind: "completed", dispatchIds: [await parentWake(tx, row), ...await wakeHead(tx, row.deploymentEpoch, attempt.token, now)] };
        }
        if (row.status !== "running" || row.attemptToken !== attempt.token || row.executorOwner !== attempt.owner || row.leaseExpiresAt! <= now || row.operationDeadlineAt <= now) return { kind: "superseded", dispatchIds: [] };
        await capacity(tx, row.deploymentEpoch, now);
        await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${attempt.token}::uuid FOR UPDATE`;
        const closed = await tx.executionAttempt.updateMany({ where: { attemptToken: attempt.token, owner: attempt.owner, status: "running", revokedAt: null, leaseExpiresAt: { gt: now }, operationDeadlineAt: { gt: now } },
          data: { status: "completed", finishedAt: now } });
        if (closed.count !== 1) return { kind: "superseded", dispatchIds: [] };
        const completed = await tx.clipSelectionWindow.update({ where: { id: row.id }, data: { status: "completed", leaseExpiresAt: null, completedAt: now, resultStorageKey: result.storageKey,
          resultEtag: result.etag, resultHash: result.sha256, resultByteLength: BigInt(result.byteLength), tokensUsed: result.tokensUsed, providerRequestId: result.providerRequestId } });
        return { kind: "completed", dispatchIds: [await parentWake(tx, completed), ...await wakeHead(tx, row.deploymentEpoch, attempt.token, now)] };
      });
    },
    async retry(attempt: ClipSelectionWindowAttempt, failure: { code: string; dueAt?: Date }): Promise<ClipSelectionWindowSettlement> {
      if (!/^[a-z][a-z0-9_]{0,99}$/.test(failure.code) || (failure.dueAt && !Number.isFinite(failure.dueAt.getTime()))) throw new Error("Invalid selection failure");
      return transaction(async tx => {
        const state = await lockWindow(tx, attempt.reference);
        if (!state || state.row.status !== "running" || state.row.attemptToken !== attempt.token || state.row.executorOwner !== attempt.owner || state.row.leaseExpiresAt! <= state.now || state.row.operationDeadlineAt <= state.now) return { kind: "superseded", dispatchIds: await replayWakes(tx, attempt.reference) };
        return finish(tx, state.row, state.now, { failureCode: failure.code, dueAt: failure.dueAt });
      });
    },
    async expire(reference: ExecutionDispatchReference): Promise<ClipSelectionWindowAdmission> {
      return transaction(async tx => {
        const state = await lockWindow(tx, reference, true);
        if (!state) return { kind: "superseded", dispatchIds: await replayWakes(tx, reference) };
        const { row, now } = state;
        if (["completed", "failed", "cancelled"].includes(row.status)) return { kind: row.status as "completed" | "failed" | "cancelled", dispatchIds: [await parentWake(tx, row)] };
        if (row.operationDeadlineAt <= now) return { ...await finish(tx, row, now, { failureCode: "operation_deadline_exceeded" }), kind: "failed" };
        if (row.status === "running" && row.leaseExpiresAt! <= now) return { kind: "superseded", dispatchIds: (await finish(tx, row, now, { failureCode: "executor_lease_expired", dueAt: now })).dispatchIds };
        return { kind: "wait", dueAt: row.leaseExpiresAt ?? row.operationDeadlineAt, dispatchIds: [] };
      });
    },
  };
}
