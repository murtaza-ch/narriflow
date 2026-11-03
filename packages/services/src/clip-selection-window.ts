import { Prisma, type ClipSelectionWindow, type PrismaClient, type Transcript } from "@prisma/client";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, executionDispatchIdentity, readExecutionDispatch } from "./execution-dispatch";
import { lockWorkspaceUsage } from "./processing-usage";
import { accessibleProjectWhere } from "./project-access";
import { workflowRunExecutionInputHash } from "./workflow-execution-input";
import { admitMediaCleanupObligations } from "./media-cleanup";
import { lockPlannedExecutionObject } from "./execution-object-cleanup";

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
  | { kind: "acquired"; attempt: ClipSelectionWindowAttempt; input: ClipSelectionObjectReference; windowIndex: number; operationDeadlineAt: Date; leaseExpiresAt: Date; dispatchIds: string[] }
  | { kind: "wait"; dueAt: Date; dispatchIds: string[] }
  | { kind: "completed" | "failed" | "cancelled" | "superseded"; dispatchIds: string[] };
export type ClipSelectionWindowSettlement = { kind: "completed" | "retried" | "failed" | "cancelled" | "superseded"; dispatchIds: string[] };
export type ClipSelectionWindowStart = { kind: "started" | "already_started"; now: Date; leaseExpiresAt: Date; operationDeadlineAt: Date } | { kind: "superseded" };

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

export async function lockClipSelectionWindow(tx: Tx, value: ExecutionDispatchReference, historicalResult = false, verifyContent = true): Promise<{ row: ClipSelectionWindow; now: Date; current: boolean } | null> {
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
  if (historicalResult && row.status === "completed") return { row, now, current: true };
  const parent = await tx.workflowRun.findUniqueOrThrow({ where: { id: row.workflowRunId } });
  const project = await tx.project.findFirst({ where: { id: row.projectId, ...accessibleProjectWhere(now), ingestStatus: { not: "failed" }, workspace: { status: "active" } } });
  const transcript = await tx.transcript.findUnique({ where: { projectId: row.projectId }, select: { id: true, status: true, sourceRevision: true, selectionGeneration: true, workflowAttemptId: true,
    sourceAudioId: true, sourceAudio: { select: { bindingHash: true } } } });
  if (!project || !transcript || parent.stage !== "moment_detection" || parent.status !== "waiting" || parent.attemptId || parent.leaseOwner || parent.leaseExpiresAt ||
    parent.deploymentEpoch !== row.deploymentEpoch || parent.generation !== row.workflowGeneration || transcript.status !== "completed" ||
    project.sourceRevision !== row.sourceRevision || transcript.sourceRevision !== row.sourceRevision || transcript.id !== row.transcriptId ||
    transcript.selectionGeneration !== row.transcriptGeneration || transcript.workflowAttemptId !== row.transcriptAttemptId ||
    transcript.sourceAudioId !== row.sourceAudioId || (transcript.sourceAudio?.bindingHash ?? null) !== row.sourceAudioBindingHash) return { row, now, current: false };
  if (verifyContent && await clipSelectionTranscriptHash(await tx.transcript.findUniqueOrThrow({ where: { id: transcript.id } })) !== row.transcriptContentHash) return { row, now, current: false };
  return { row, now, current: true };
}

/** Parent commands freeze inputs and finalize children without a long-lived lease. */
export async function lockClipSelectionParent(tx: Tx, value: ExecutionDispatchReference) {
  const parsed = executionDispatchReferenceSchema.safeParse(value);
  if (!parsed.success || value.kind !== "operation_driver" || value.subject.kind !== "workflow_run") return null;
  const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT epoch FROM "ExecutionEpoch" WHERE id = 1 FOR SHARE`;
  const registered = await readExecutionDispatch(tx, value.dispatchId);
  if (epoch?.epoch !== value.deploymentEpoch || !registered || !sameReference(registered.reference, value)) return null;
  const initial = await tx.workflowRun.findUnique({ where: { id: value.subject.id }, include: { project: { select: { workspaceId: true } } } });
  if (!initial) return null;
  await lockWorkspaceUsage(tx, initial.project.workspaceId);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${initial.projectId}, 0)) IS NULL AS "locked"`;
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${initial.projectId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id = ${initial.id}::uuid FOR UPDATE`;
  const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: initial.id }, include: { contentPack: true } }), now = await clock(tx);
  const project = await tx.project.findFirst({ where: { id: initial.projectId, ...accessibleProjectWhere(now), ingestStatus: { not: "failed" }, workspace: { status: "active" } } });
  const transcript = await tx.transcript.findUnique({ where: { projectId: initial.projectId }, include: { sourceAudio: true } });
  if (!project || !transcript || transcript.status !== "completed" || project.sourceRevision !== transcript.sourceRevision || run.stage !== "moment_detection" ||
    run.deploymentEpoch !== value.deploymentEpoch || run.generation !== value.generation || run.attemptId || run.leaseOwner || run.leaseExpiresAt || !["queued", "waiting", "completed", "failed", "cancelled"].includes(run.status)) return null;
  const inputHash = await workflowRunExecutionInputHash({ id: run.id, projectId: run.projectId, stage: run.stage, contentPackId: run.contentPackId,
    deploymentEpoch: run.deploymentEpoch, generation: run.generation, sourceAudioId: transcript.sourceAudioId, sourceRevision: transcript.sourceRevision,
    sourceTranscript: { id: transcript.id, generation: transcript.selectionGeneration, attemptId: transcript.workflowAttemptId } });
  return inputHash === value.inputHash ? { run, project, transcript, now } : null;
}

export async function registerClipSelectionWindow(tx: Tx, row: ClipSelectionWindow): Promise<ExecutionDispatchReference> {
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
  if (row.generation > reference.generation) return [(await registerClipSelectionWindow(tx, row)).dispatchId];
  return row.status === "running" ? [await leaseWake(tx, row, reference)] : [];
}

/** No other Project or window row is locked while holding this account lock. */
async function capacity(tx: Tx, deploymentEpoch: number, now: Date) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK}, 0)) IS NULL AS "locked"`;
  // The account lock may have waited behind another Project.
  now = await clock(tx);
  const current = Prisma.sql`run.status = 'waiting' AND run.generation = w."workflowGeneration" AND run."deploymentEpoch" = w."deploymentEpoch"
    AND run."attemptId" IS NULL AND run."leaseOwner" IS NULL AND run."leaseExpiresAt" IS NULL
    AND p."ingestStatus" <> 'failed' AND p."sourceRevision" = w."sourceRevision" AND p."purgeStartedAt" IS NULL
    AND (p."expiresAt" IS NULL OR p."expiresAt" > (${now}::timestamp)) AND workspace.status = 'active'
    AND transcript.status = 'completed' AND transcript.id = w."transcriptId" AND transcript."selectionGeneration" = w."transcriptGeneration"
    AND transcript."sourceRevision" = w."sourceRevision" AND transcript."workflowAttemptId" IS NOT DISTINCT FROM w."transcriptAttemptId"
    AND transcript."sourceAudioId" IS NOT DISTINCT FROM w."sourceAudioId"`;
  const [usage] = await tx.$queryRaw<Array<{ requests: number; tokens: number; dueAt: Date | null }>>`
    SELECT COUNT(*)::integer AS requests, COALESCE(SUM(w."estimatedTokens"), 0)::double precision AS tokens, MIN(w."leaseExpiresAt") AS "dueAt"
    FROM "ClipSelectionWindow" w JOIN "WorkflowRun" run ON run.id = w."workflowRunId" JOIN "Project" p ON p.id = w."projectId"
    JOIN "Transcript" transcript ON transcript."projectId" = p.id JOIN "Workspace" workspace ON workspace.id = p."workspaceId"
    WHERE w."deploymentEpoch" = ${deploymentEpoch} AND w.status = 'running' AND w."leaseExpiresAt" > (${now}::timestamp)
      AND ${current}
  `;
  if (!usage) throw new Error("Selection capacity unavailable");
  // A Project takes one turn at a time. Its next turn sorts after every Project
  // that has not started since, independent of the number of queued windows.
  const [head] = await tx.$queryRaw<Array<{ id: string; operationDeadlineAt: Date }>>`
    SELECT w.id, w."operationDeadlineAt" FROM "ClipSelectionWindow" w
    JOIN "WorkflowRun" run ON run.id = w."workflowRunId" JOIN "Project" p ON p.id = w."projectId"
    JOIN "Transcript" transcript ON transcript."projectId" = p.id JOIN "Workspace" workspace ON workspace.id = p."workspaceId"
    WHERE w."deploymentEpoch" = ${deploymentEpoch} AND w.status = 'queued' AND (w."retryAt" IS NULL OR w."retryAt" <= (${now}::timestamp) OR w."errorCode" = ${CLIP_SELECTION_CAPACITY_WAIT})
      AND w."operationDeadlineAt" > (${now}::timestamp) AND ${current}
    ORDER BY (SELECT MAX(turn."lastProviderStartedAt") FROM "ClipSelectionWindow" turn WHERE turn."projectId" = w."projectId" AND turn."deploymentEpoch" = w."deploymentEpoch") ASC NULLS FIRST,
      w."providerQueuedAt" ASC, w."windowIndex" ASC, w.id ASC LIMIT 1
  `;
  return { ...usage, head, now };
}
export async function appendClipSelectionCapacityWake(tx: Tx, deploymentEpoch: number, cause: string, now: Date): Promise<string[]> {
  const { head } = await capacity(tx, deploymentEpoch, now);
  if (!head) return [];
  const row = await tx.clipSelectionWindow.findUniqueOrThrow({ where: { id: head.id } });
  const reference = await registerClipSelectionWindow(tx, row);
  // Epoch zero is a stable due time for replay of this exact release hint.
  const wake = await appendExecutionDispatch(tx, { ...reference, subject: reference.subject, dueAt: new Date(0), wakeKind: `sel_${cause.replaceAll("-", "")}` });
  return [wake.reference.dispatchId];
}

async function retireSupersededWindow(tx: Tx, state: { row: ClipSelectionWindow; now: Date }): Promise<string[]> {
  const { row, now } = state;
  if (!["queued", "running"].includes(row.status)) return [await parentWake(tx, row)];
  await capacity(tx, row.deploymentEpoch, now);
  if (row.attemptToken) {
    await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${row.attemptToken}::uuid FOR UPDATE`;
    await tx.executionAttempt.updateMany({ where: { attemptToken: row.attemptToken, status: { in: ["admitted", "running"] } }, data: { status: "superseded", failureCode: "selection_source_superseded", revokedAt: now, finishedAt: now } });
  }
  const cancelled = await tx.clipSelectionWindow.update({ where: { id: row.id }, data: { status: "cancelled", errorCode: "selection_source_superseded", leaseExpiresAt: null, completedAt: now } });
  return [await parentWake(tx, cancelled), ...await appendClipSelectionCapacityWake(tx, row.deploymentEpoch, row.attemptToken ?? row.id, now)];
}

/** Caller holds the Project/parent locks; finished results remain reusable. */
export async function cancelClipSelectionWindowsWithinTransaction(tx: Tx, input: { projectId: string; workflowRunId?: string; deploymentEpoch: number; errorCode: string; now: Date; cause: string }): Promise<string[]> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK}, 0)) IS NULL AS "locked"`;
  const active = await tx.clipSelectionWindow.findMany({ where: { projectId: input.projectId, deploymentEpoch: input.deploymentEpoch,
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}), status: { in: ["queued", "running"] } }, orderBy: { id: "asc" }, select: { id: true, attemptToken: true } });
  const tokens = active.flatMap(row => row.attemptToken ? [row.attemptToken] : []).sort();
  if (tokens.length) {
    await tx.$queryRaw(Prisma.sql`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" IN (${Prisma.join(tokens.map(token => Prisma.sql`${token}::uuid`))}) ORDER BY "attemptToken" FOR UPDATE`);
    await tx.executionAttempt.updateMany({ where: { attemptToken: { in: tokens }, status: { in: ["admitted", "running"] } }, data: { status: "cancelled", failureCode: input.errorCode, revokedAt: input.now, finishedAt: input.now } });
  }
  if (active.length) await tx.clipSelectionWindow.updateMany({ where: { id: { in: active.map(row => row.id) } }, data: { status: "cancelled", errorCode: input.errorCode, leaseExpiresAt: null, completedAt: input.now } });
  return active.length ? appendClipSelectionCapacityWake(tx, input.deploymentEpoch, input.cause, input.now) : [];
}

export function clipSelectionWindowResultKey(attempt: ClipSelectionWindowAttempt, sha: string, nonce: string): string {
  if (!uuid(attempt.token) || !uuid(attempt.owner) || !uuid(nonce) || !/^[a-f0-9]{64}$/.test(sha)) throw new Error("Invalid selection result identity");
  return `execution/${attempt.reference.deploymentEpoch}/clip_selection_window/${attempt.reference.subject.id}/${attempt.reference.generation}/${attempt.token}/${attempt.owner}/selection_window/${nonce}/${sha}.json`;
}

/** Short authoritative commands. Provider and storage I/O never run under locks. */
export function createClipSelectionLifecycle(config: { database: PrismaClient; maxInFlightRequests: number; maxEstimatedTokens: number }) {
  if (!Number.isSafeInteger(config.maxInFlightRequests) || config.maxInFlightRequests <= 0 || !Number.isSafeInteger(config.maxEstimatedTokens) || config.maxEstimatedTokens <= 0) throw new RangeError("Explicit selection provider request and token limits are required");
  const transaction = <T>(body: (tx: Tx) => Promise<T>) => config.database.$transaction(body, { maxWait: 10_000, timeout: 30_000 });

  async function finish(tx: Tx, row: ClipSelectionWindow, observedAt: Date, input: { failureCode: string; dueAt?: Date; requireLiveOwner?: boolean }): Promise<ClipSelectionWindowSettlement> {
    await capacity(tx, row.deploymentEpoch, observedAt);
    if (row.attemptToken) {
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${row.attemptToken}::uuid FOR UPDATE`;
    }
    const now = await clock(tx);
    if (input.requireLiveOwner && (!row.leaseExpiresAt || row.leaseExpiresAt <= now || row.operationDeadlineAt <= now)) return { kind: "superseded", dispatchIds: [await leaseWake(tx, row, await registerClipSelectionWindow(tx, row))] };
    if (row.attemptToken) {
      await tx.executionAttempt.updateMany({ where: { attemptToken: row.attemptToken, status: { in: ["admitted", "running"] } },
        data: { status: "failed", failureCode: input.failureCode, revokedAt: now, finishedAt: now } });
    }
    const retryAt = input.dueAt ? new Date(Math.min(Math.max(now.getTime(), input.dueAt.getTime()), row.operationDeadlineAt.getTime())) : null;
    const retry = row.status === "running" && retryAt !== null && retryAt < row.operationDeadlineAt && row.attemptCount < row.maxAttempts;
    const next = await tx.clipSelectionWindow.update({ where: { id: row.id }, data: retry
      ? { status: "queued", generation: { increment: 1 }, attemptToken: null, executorOwner: null, leaseExpiresAt: null, retryAt, errorCode: input.failureCode }
      : { status: "failed", leaseExpiresAt: null, errorCode: input.failureCode, completedAt: now } });
    const dispatchIds = retry ? [(await registerClipSelectionWindow(tx, next)).dispatchId] : [await parentWake(tx, next)];
    dispatchIds.push(...await appendClipSelectionCapacityWake(tx, row.deploymentEpoch, row.attemptToken ?? row.id, now));
    return { kind: retry ? "retried" : "failed", dispatchIds };
  }

  return {
    async admit(reference: ExecutionDispatchReference, invocation: { owner: string }): Promise<ClipSelectionWindowAdmission> {
      if (!uuid(invocation.owner)) throw new Error("Invalid selection invocation owner");
      return transaction(async tx => {
        const state = await lockClipSelectionWindow(tx, reference, true, false);
        if (!state) return { kind: "superseded", dispatchIds: await replayWakes(tx, reference) };
        if (!state.current) return { kind: "superseded", dispatchIds: await retireSupersededWindow(tx, state) };
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
        if (row.operationDeadlineAt <= used.now) return { ...await finish(tx, row, used.now, { failureCode: "operation_deadline_exceeded" }), kind: "failed" };
        if (used.head?.id !== row.id || used.requests >= config.maxInFlightRequests || used.tokens + row.estimatedTokens > config.maxEstimatedTokens) {
          const dueAt = new Date(Math.min(row.operationDeadlineAt.getTime(), used.dueAt?.getTime() ?? used.head?.operationDeadlineAt.getTime() ?? row.operationDeadlineAt.getTime()));
          await tx.clipSelectionWindow.update({ where: { id: row.id }, data: { errorCode: CLIP_SELECTION_CAPACITY_WAIT, retryAt: dueAt } });
          const dispatchIds = used.head && used.head.id !== row.id && used.requests < config.maxInFlightRequests && used.tokens < config.maxEstimatedTokens
            ? await appendClipSelectionCapacityWake(tx, row.deploymentEpoch, row.id, now) : [];
          return { kind: "wait", dueAt, dispatchIds };
        }
        // Denied waiters never load the full word graph. Only the next permit
        // holder proves its frozen contents before acquiring ownership.
        const transcript = await tx.transcript.findUniqueOrThrow({ where: { id: row.transcriptId } });
        if (await clipSelectionTranscriptHash(transcript) !== row.transcriptContentHash) return { kind: "superseded", dispatchIds: await retireSupersededWindow(tx, state) };
        const activeNow = await clock(tx);
        if (row.operationDeadlineAt <= activeNow) return { ...await finish(tx, row, activeNow, { failureCode: "operation_deadline_exceeded" }), kind: "failed" };
        const token = crypto.randomUUID(), leaseExpiresAt = new Date(Math.min(activeNow.getTime() + 120_000, row.operationDeadlineAt.getTime()));
        await tx.executionAttempt.create({ data: { attemptToken: token, dispatchId: reference.dispatchId, deploymentEpoch: row.deploymentEpoch, generation: row.generation,
          inputHash: row.inputHash, functionName: "clip_selection_window", inputStorageKey: row.inputStorageKey, inputEtag: row.inputEtag, inputByteLength: row.inputByteLength,
          inputChecksumSha256: row.inputChecksumSha256, owner: invocation.owner, leaseExpiresAt, operationDeadlineAt: row.operationDeadlineAt, status: "admitted" } });
        await tx.clipSelectionWindow.update({ where: { id: row.id }, data: { status: "running", attemptToken: token, executorOwner: invocation.owner, leaseExpiresAt,
          lastProviderStartedAt: activeNow, errorCode: null, retryAt: null } });
        const dispatchIds = [await leaseWake(tx, { ...row, leaseExpiresAt }, reference), ...await appendClipSelectionCapacityWake(tx, row.deploymentEpoch, token, activeNow)];
        return { kind: "acquired", attempt: { reference, token, owner: invocation.owner }, input: { storageKey: row.inputStorageKey, etag: row.inputEtag,
          sha256: row.inputChecksumSha256, byteLength: Number(row.inputByteLength) }, windowIndex: row.windowIndex, operationDeadlineAt: row.operationDeadlineAt, leaseExpiresAt, dispatchIds };
      });
    },
    /** Only a fresh started response authorizes one provider POST. */
    async start(attempt: ClipSelectionWindowAttempt): Promise<ClipSelectionWindowStart> {
      return transaction(async tx => {
        const state = await lockClipSelectionWindow(tx, attempt.reference);
        if (!state?.current || state.row.status !== "running" || state.row.attemptToken !== attempt.token || state.row.executorOwner !== attempt.owner ||
          state.row.leaseExpiresAt! <= state.now || state.row.operationDeadlineAt <= state.now) return { kind: "superseded" };
        await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${attempt.token}::uuid FOR UPDATE`;
        const activeNow = await clock(tx);
        const execution = await tx.executionAttempt.findUnique({ where: { attemptToken: attempt.token } });
        if (!execution || execution.owner !== attempt.owner || execution.revokedAt || !["admitted", "running"].includes(execution.status) ||
          !execution.leaseExpiresAt || execution.leaseExpiresAt <= activeNow || execution.operationDeadlineAt <= activeNow) return { kind: "superseded" };
        const times = { now: activeNow, leaseExpiresAt: execution.leaseExpiresAt, operationDeadlineAt: execution.operationDeadlineAt };
        if (execution.processStartedAt) return { kind: "already_started", ...times };
        if (state.row.attemptCount >= state.row.maxAttempts) return { kind: "superseded" };
        await tx.executionAttempt.update({ where: { attemptToken: attempt.token }, data: { status: "running", processStartedAt: activeNow } });
        await tx.clipSelectionWindow.update({ where: { id: state.row.id }, data: { attemptCount: { increment: 1 } } });
        return { kind: "started", ...times };
      });
    },
    async rejectInput(reference: ExecutionDispatchReference): Promise<ClipSelectionWindowSettlement> {
      return transaction(async tx => {
        const state = await lockClipSelectionWindow(tx, reference);
        if (state && !state.current) return { kind: "superseded", dispatchIds: await retireSupersededWindow(tx, state) };
        if (!state || state.row.status !== "queued") return { kind: "superseded", dispatchIds: await replayWakes(tx, reference) };
        return finish(tx, state.row, state.now, { failureCode: "selection_input_invalid" });
      });
    },
    async planResultWrite(attempt: ClipSelectionWindowAttempt, sha256: string): Promise<{ storageKey: string }> {
      const storageKey = clipSelectionWindowResultKey(attempt, sha256, crypto.randomUUID());
      return transaction(async tx => {
        const state = await lockClipSelectionWindow(tx, attempt.reference, true);
        if (!state?.current || state.row.status !== "running" || state.row.attemptToken !== attempt.token || state.row.executorOwner !== attempt.owner) throw new Error("Selection owner lost");
        await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${attempt.token}::uuid FOR UPDATE`;
        const execution = await tx.executionAttempt.findUnique({ where: { attemptToken: attempt.token } });
        const now = await clock(tx);
        if (!execution || execution.owner !== attempt.owner || execution.status !== "running" || execution.revokedAt || !execution.processStartedAt ||
          !execution.leaseExpiresAt || execution.leaseExpiresAt <= now || execution.operationDeadlineAt <= now || state.row.leaseExpiresAt! <= now || state.row.operationDeadlineAt <= now) throw new Error("Selection owner lost");
        await admitMediaCleanupObligations(tx, [{ origin: "selection_execution", cleanupClass: "execution_input", projectId: state.row.projectId,
          objectKey: storageKey, notBefore: new Date(state.row.operationDeadlineAt.getTime() + 120_000) }]);
        return { storageKey };
      });
    },
    async complete(attempt: ClipSelectionWindowAttempt, result: ClipSelectionObjectReference & { tokensUsed: number; providerRequestId: string | null }): Promise<ClipSelectionWindowSettlement> {
      if (result.storageKey !== clipSelectionWindowResultKey(attempt, result.sha256, result.storageKey.split("/").at(-2) ?? "") || !/^"[^\r\n"]+"$/.test(result.etag) || !Number.isSafeInteger(result.byteLength) || result.byteLength < 1 || result.byteLength > 1_048_576 ||
        !Number.isSafeInteger(result.tokensUsed) || result.tokensUsed < 0 || (result.providerRequestId !== null && result.providerRequestId.length > 160)) throw new Error("Invalid selection result reference");
      return transaction(async tx => {
        const state = await lockClipSelectionWindow(tx, attempt.reference, true);
        if (!state) return { kind: "superseded", dispatchIds: await replayWakes(tx, attempt.reference) };
        if (!state.current) return { kind: "superseded", dispatchIds: await retireSupersededWindow(tx, state) };
        const { row, now } = state;
        if (row.status === "completed") {
          if (row.attemptToken !== attempt.token || row.executorOwner !== attempt.owner || row.resultStorageKey !== result.storageKey || row.resultEtag !== result.etag || row.resultHash !== result.sha256 || row.resultByteLength !== BigInt(result.byteLength) ||
            row.tokensUsed !== result.tokensUsed || row.providerRequestId !== result.providerRequestId) throw new Error("Selection result receipt conflict");
          return { kind: "completed", dispatchIds: [await parentWake(tx, row), ...await appendClipSelectionCapacityWake(tx, row.deploymentEpoch, attempt.token, now)] };
        }
        if (row.status !== "running" || row.attemptToken !== attempt.token || row.executorOwner !== attempt.owner || row.leaseExpiresAt! <= now || row.operationDeadlineAt <= now) return { kind: "superseded", dispatchIds: [] };
        await capacity(tx, row.deploymentEpoch, now);
        await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${attempt.token}::uuid FOR UPDATE`;
        const commitAt = await clock(tx);
        if (row.leaseExpiresAt! <= commitAt || row.operationDeadlineAt <= commitAt) return { kind: "superseded", dispatchIds: [await leaseWake(tx, row, attempt.reference)] };
        await lockPlannedExecutionObject(tx, { origin: "selection_execution", storageKey: result.storageKey });
        const closed = await tx.executionAttempt.updateMany({ where: { attemptToken: attempt.token, owner: attempt.owner, status: "running", revokedAt: null, leaseExpiresAt: { gt: commitAt }, operationDeadlineAt: { gt: commitAt } },
          data: { status: "completed", finishedAt: commitAt } });
        if (closed.count !== 1) return { kind: "superseded", dispatchIds: [] };
        const completed = await tx.clipSelectionWindow.update({ where: { id: row.id }, data: { status: "completed", leaseExpiresAt: null, completedAt: commitAt, resultStorageKey: result.storageKey,
          resultEtag: result.etag, resultHash: result.sha256, resultByteLength: BigInt(result.byteLength), tokensUsed: result.tokensUsed, providerRequestId: result.providerRequestId } });
        return { kind: "completed", dispatchIds: [await parentWake(tx, completed), ...await appendClipSelectionCapacityWake(tx, row.deploymentEpoch, attempt.token, now)] };
      });
    },
    async retry(attempt: ClipSelectionWindowAttempt, failure: { code: string; dueAt?: Date }): Promise<ClipSelectionWindowSettlement> {
      if (!/^[a-z][a-z0-9_]{0,99}$/.test(failure.code) || (failure.dueAt && !Number.isFinite(failure.dueAt.getTime()))) throw new Error("Invalid selection failure");
      return transaction(async tx => {
        const state = await lockClipSelectionWindow(tx, attempt.reference);
        if (state && !state.current) return { kind: "superseded", dispatchIds: await retireSupersededWindow(tx, state) };
        if (!state || state.row.status !== "running" || state.row.attemptToken !== attempt.token || state.row.executorOwner !== attempt.owner || state.row.leaseExpiresAt! <= state.now || state.row.operationDeadlineAt <= state.now) return { kind: "superseded", dispatchIds: await replayWakes(tx, attempt.reference) };
        return finish(tx, state.row, state.now, { failureCode: failure.code, dueAt: failure.dueAt, requireLiveOwner: true });
      });
    },
    async expire(reference: ExecutionDispatchReference): Promise<ClipSelectionWindowAdmission> {
      return transaction(async tx => {
        const state = await lockClipSelectionWindow(tx, reference, true);
        if (!state) return { kind: "superseded", dispatchIds: await replayWakes(tx, reference) };
        if (!state.current) return { kind: "superseded", dispatchIds: await retireSupersededWindow(tx, state) };
        const { row, now } = state;
        if (["completed", "failed", "cancelled"].includes(row.status)) return { kind: row.status as "completed" | "failed" | "cancelled", dispatchIds: [await parentWake(tx, row)] };
        if (row.operationDeadlineAt <= now) return { ...await finish(tx, row, now, { failureCode: "operation_deadline_exceeded" }), kind: "failed" };
        if (row.status === "running" && row.leaseExpiresAt! <= now) return { kind: "superseded", dispatchIds: (await finish(tx, row, now, { failureCode: "executor_lease_expired", dueAt: now })).dispatchIds };
        return { kind: "wait", dueAt: row.leaseExpiresAt ?? row.operationDeadlineAt, dispatchIds: [] };
      });
    },
  };
}
