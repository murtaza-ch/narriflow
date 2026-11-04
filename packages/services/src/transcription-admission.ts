import type { Prisma, PrismaClient } from "@prisma/client";
import { executionDispatchReferenceSchema, providerAttemptReferenceSchema, type ExecutionDispatchReference, type ExecutionDisposition } from "@narriflow/validators/execution";
import { appendExecutionDispatch, readExecutionDispatch, executionDispatchIdentity } from "./execution-dispatch";
import type { ProviderSubmissionIntent, WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { flushWorkspaceEvents } from "./workspace-event";
import { takeExecutionDispatchIds } from "./execution-dispatch-runtime";
import { flushProjectProgressDrains, queueProjectProgressCatchup } from "./progress-outbox";
import { databaseNow } from "./execution-clock";

type Tx = Prisma.TransactionClient;
const CAPACITY_LOCK = "provider_capacity:elevenlabs:scribe_v2";
export const SCRIBE_CAPACITY_WAIT = "provider_capacity_wait";

/** Scribe v2's published duration-weighted concurrency units. */
export function scribeConcurrencyUnits(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new RangeError("Invalid Source Audio duration");
  return Math.min(4, Math.ceil(durationSeconds / 480));
}

export type TranscriptionAdmissionResult =
  | { kind: "begun"; intent: ProviderSubmissionIntent; languageCode: string | null; dispatchIds: string[] }
  | { kind: "already_waiting"; intent: ProviderSubmissionIntent; dispatchIds: string[] }
  | { kind: "capacity_wait" | "retry_wait"; dueAt: Date; dispatchIds: string[] }
  | { kind: "audio_pending" | "superseded"; dispatchIds: string[] }
  | { kind: "completed"; dispatchIds: string[] }
  | { kind: "terminal"; disposition: ExecutionDisposition; dispatchIds: string[] };


/** Caller owns this run's ordinary domain locks. No other run is row-locked. */
export async function readScribeCapacityWithinTransaction(tx: Tx, excludeRunId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK}, 0)) IS NULL AS "locked"`;
  const now = await databaseNow(tx);
  const [usage] = await tx.$queryRaw<Array<{ usedUnits: number; dueAt: Date | null }>>`
    SELECT COALESCE(SUM(LEAST(4, CEIL(audio."durationSeconds" / 480))), 0)::double precision AS "usedUnits",
      MIN(CASE WHEN run.status = 'running' THEN run."leaseExpiresAt"
        ELSE COALESCE(transcript."providerResultDeadlineAt", transcript."providerSubmissionDeadlineAt") END) AS "dueAt"
    FROM "WorkflowRun" run JOIN "Project" project ON project.id = run."projectId"
    JOIN "ExecutionEpoch" epoch ON epoch.id = 1 AND epoch.epoch = run."deploymentEpoch"
    JOIN "Transcript" transcript ON transcript."projectId" = run."projectId" AND transcript."sourceRevision" = project."sourceRevision"
    JOIN "SourceAudio" audio ON audio.id = transcript."sourceAudioId" AND audio."projectId" = transcript."projectId" AND audio."sourceRevision" = transcript."sourceRevision"
    WHERE run.stage = 'stt' AND project."ingestStatus" <> 'failed' AND run.id <> ${excludeRunId}::uuid AND (
      (run.status = 'running' AND run."leaseExpiresAt" > (${now}::timestamp)) OR
      (run.status = 'waiting' AND transcript."workflowAttemptId" = run."attemptId" AND
        COALESCE(transcript."providerResultDeadlineAt", transcript."providerSubmissionDeadlineAt") > (${now}::timestamp))
    )
  `;
  if (!usage) throw new Error("Provider capacity unavailable");
  return { ...usage, now };
}

/** Capacity release is a hint. Every awakened run must recount before a POST. */
export async function appendScribeCapacityWakesWithinTransaction(tx: Tx, input: { deploymentEpoch: number; attemptId: string; afterRunId?: string }): Promise<{ dispatchIds: string[] }> {
  if (!providerAttemptReferenceSchema.shape.attemptId.safeParse(input.attemptId).success) throw new Error("Invalid capacity release identity");
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK}, 0)) IS NULL AS "locked"`;
  const cursor = input.afterRunId ? await tx.workflowRun.findUnique({ where: { id: input.afterRunId }, select: { createdAt: true, id: true } }) : null;
  if (input.afterRunId && !cursor) throw new Error("Capacity continuation cursor missing");
  const waiting = await tx.workflowRun.findMany({ where: { deploymentEpoch: input.deploymentEpoch, stage: "stt", status: "queued", errorCode: SCRIBE_CAPACITY_WAIT,
    project: { ingestStatus: { not: "failed" } }, ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 101 });
  const now = await databaseNow(tx), dispatchIds: string[] = [];
  for (const run of waiting.slice(0, 100)) {
    const registered = await tx.executionDispatch.findFirstOrThrow({ where: { deploymentEpoch: run.deploymentEpoch, subjectKind: "workflow_run", subjectId: run.id,
      generation: run.generation, kind: "operation_driver", wakeKind: null, deadlineKind: null }, orderBy: { createdAt: "asc" } });
    const identity = { deploymentEpoch: run.deploymentEpoch, kind: "operation_driver" as const, subject: { kind: "workflow_run" as const, id: run.id }, generation: run.generation,
      wakeKind: `cap_${input.attemptId.replaceAll("-", "")}` };
    const existing = await tx.executionDispatch.findUnique({ where: { deliveryKey: (await executionDispatchIdentity(identity)).deliveryKey }, select: { dueAt: true } });
    const wake = await appendExecutionDispatch(tx, { ...identity, dueAt: existing?.dueAt ?? now, inputHash: registered.inputHash });
    dispatchIds.push(wake.reference.dispatchId);
  }
  if (waiting.length > 100) {
    const last = waiting[99]!;
    const registration = await tx.executionDispatch.findFirst({ where: { deploymentEpoch: last.deploymentEpoch, subjectKind: "workflow_run", subjectId: last.id, generation: last.generation,
      kind: "operation_driver", wakeKind: `cap_${input.attemptId.replaceAll("-", "")}` } });
    if (!registration) throw new Error("Capacity continuation registration missing");
    const continuation = await appendExecutionDispatch(tx, { deploymentEpoch: last.deploymentEpoch, kind: "operation_driver", subject: { kind: "workflow_run", id: last.id },
      generation: last.generation, inputHash: registration.inputHash, dueAt: registration.dueAt, wakeKind: `stt_${input.attemptId.replaceAll("-", "")}` });
    dispatchIds.push(continuation.reference.dispatchId);
  }
  return { dispatchIds };
}

/** Continues only a persisted release page. No caller-supplied queue cursor. */
export async function continueScribeCapacityRelease(database: PrismaClient, value: ExecutionDispatchReference): Promise<{ dispatchIds: string[] }> {
  const reference = executionDispatchReferenceSchema.parse(value);
  return database.$transaction(async tx => {
    const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
    const record = await readExecutionDispatch(tx, reference.dispatchId);
    if (epoch?.epoch !== reference.deploymentEpoch || !record || JSON.stringify(record.reference) !== JSON.stringify(reference) ||
      reference.kind !== "operation_driver" || reference.subject.kind !== "workflow_run" || !/^stt_[a-f0-9]{32}$/.test(record.wakeKind ?? "")) return { dispatchIds: [] };
    const hex = record.wakeKind!.slice(4), attemptId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return appendScribeCapacityWakesWithinTransaction(tx, { deploymentEpoch: reference.deploymentEpoch, attemptId, afterRunId: reference.subject.id });
  }, { maxWait: 10_000, timeout: 30_000 });
}

/** A typed server command; callers cannot inject SQL, payloads or provider URLs. */
export function createTranscriptionAdmission(input: { database: PrismaClient; workflow: WorkflowRunLifecycle; maxUnits: number }) {
  if (!Number.isSafeInteger(input.maxUnits) || input.maxUnits <= 0) throw new RangeError("An explicit Scribe concurrency cap is required");
  return {
    async admit(value: ExecutionDispatchReference, invocation: { owner: string }): Promise<TranscriptionAdmissionResult> {
      const parsed = executionDispatchReferenceSchema.safeParse(value);
      if (!parsed.success || parsed.data.kind !== "operation_driver" || parsed.data.subject.kind !== "workflow_run" ||
        !providerAttemptReferenceSchema.shape.workflowRunId.safeParse(parsed.data.subject.id).success) return { kind: "superseded", dispatchIds: [] };
      if (!providerAttemptReferenceSchema.shape.attemptId.safeParse(invocation.owner).success) throw new Error("Invalid TS invocation owner");
      const reference = parsed.data;
      return input.database.$transaction(async tx => {
        const result = await (async (): Promise<TranscriptionAdmissionResult> => {
          const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
          if (epoch?.epoch !== reference.deploymentEpoch) return { kind: "superseded", dispatchIds: [] };
          const ledger = (await readExecutionDispatch(tx, reference.dispatchId))?.reference;
          if (!ledger || ledger.kind !== reference.kind || ledger.subject.kind !== reference.subject.kind || ledger.subject.id !== reference.subject.id ||
            ledger.deploymentEpoch !== reference.deploymentEpoch || ledger.generation !== reference.generation || ledger.inputHash !== reference.inputHash) return { kind: "superseded", dispatchIds: [] };
          const initial = await tx.workflowRun.findUnique({ where: { id: reference.subject.id }, select: { stage: true, attemptId: true } });
          if (!initial || initial.stage !== "stt") return { kind: "superseded", dispatchIds: [] };
          const prospectiveToken = crypto.randomUUID();
          let locked = await input.workflow.lockExecution(tx, reference, initial.attemptId ?? prospectiveToken);
          // Another invocation may have committed intent while this one waited for
          // the Project lock. It can read that lineage, never start another POST.
          const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: reference.subject.id } });
          queueProjectProgressCatchup(tx, run.projectId);
          if (locked.kind === "terminal" && locked.disposition.disposition === "superseded" && run.status === "waiting" && run.attemptId &&
            run.deploymentEpoch === reference.deploymentEpoch && run.generation === reference.generation) locked = await input.workflow.lockExecution(tx, reference, run.attemptId);
          if (locked.kind === "terminal") return { kind: "terminal", disposition: locked.disposition,
            dispatchIds: locked.disposition.disposition === "completed" ? await input.workflow.readCompletedTranscriptionWakesWithinTransaction(tx, reference) : [] };
          const now = await databaseNow(tx);
          if (run.status === "waiting") {
            const history = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken: run.attemptId! } });
            const intent = await input.workflow.beginProviderSubmissionExecution(tx, locked.ref, { reference, attemptToken: run.attemptId!, owner: invocation.owner, now,
              leaseExpiresAt: history.leaseExpiresAt!, operationDeadlineAt: history.operationDeadlineAt, functionName: "stt" });
            return { kind: "already_waiting", intent, dispatchIds: intent.dispatchIds };
          }
          if (run.status !== "queued" || run.attemptId || run.leaseOwner) {
            if (!run.leaseExpiresAt) return { kind: "superseded", dispatchIds: [] };
            return { kind: "retry_wait", dueAt: run.leaseExpiresAt, dispatchIds: [] };
          }
          if (run.nextAttemptAt && run.nextAttemptAt > now && run.errorCode !== SCRIBE_CAPACITY_WAIT) return { kind: "retry_wait", dueAt: run.nextAttemptAt, dispatchIds: [] };
          const plan = await input.workflow.completeTranscriptionPlanWithinTransaction(tx, locked.ref);
          if (plan.kind === "completed") return plan;
          const transcript = await tx.transcript.findUnique({ where: { projectId: run.projectId }, include: { sourceAudio: true } });
          const audio = transcript?.sourceAudio;
          if (!audio) return { kind: "audio_pending", dispatchIds: [] };
          const units = scribeConcurrencyUnits(audio.durationSeconds);
          if (units > input.maxUnits) throw new RangeError("Scribe concurrency cap cannot admit this source's weight");
          const capacity = await readScribeCapacityWithinTransaction(tx, run.id);
          if (capacity.usedUnits + units > input.maxUnits) {
            if (!capacity.dueAt) throw new Error("Provider capacity deadline missing");
            await tx.workflowRun.update({ where: { id: run.id }, data: { errorCode: SCRIBE_CAPACITY_WAIT, nextAttemptAt: capacity.dueAt } });
            const wake = await appendExecutionDispatch(tx, { deploymentEpoch: reference.deploymentEpoch, kind: "operation_driver", subject: reference.subject,
              generation: reference.generation, inputHash: reference.inputHash, dueAt: capacity.dueAt, wakeKind: "capacity_retry", deadlineKind: "retry", observedDeadlineAt: capacity.dueAt });
            return { kind: "capacity_wait", dueAt: capacity.dueAt, dispatchIds: [wake.reference.dispatchId] };
          }
          if (run.errorCode === SCRIBE_CAPACITY_WAIT) await tx.workflowRun.update({ where: { id: run.id }, data: { errorCode: null, nextAttemptAt: null } });
          const activeNow = await databaseNow(tx);
          const operationDeadlineAt = new Date(activeNow.getTime() + 10 * 60_000), leaseExpiresAt = new Date(activeNow.getTime() + 120_000);
          await tx.executionAttempt.create({ data: { attemptToken: prospectiveToken, dispatchId: reference.dispatchId, deploymentEpoch: reference.deploymentEpoch,
            generation: reference.generation, inputHash: reference.inputHash, functionName: "stt", operationDeadlineAt } });
          const intent = await input.workflow.beginProviderControlWithinTransaction(tx, locked.ref, { reference, attemptToken: prospectiveToken, owner: invocation.owner,
            now: activeNow, leaseExpiresAt, operationDeadlineAt, functionName: "stt" });
          return { kind: "begun", intent, languageCode: plan.languageCode, dispatchIds: intent.dispatchIds };
        })();
        await flushWorkspaceEvents(tx);
        return { ...result, dispatchIds: [...new Set([...result.dispatchIds, ...await flushProjectProgressDrains(tx), ...takeExecutionDispatchIds(tx)])] };
      }, { maxWait: 10_000, timeout: 30_000 });
    },
  };
}
