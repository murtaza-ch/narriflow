import type { PrismaClient } from "@prisma/client";
import { executionDispatchReferenceSchema, executionMediaFunctionSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, ExecutionDispatchError, readExecutionDispatch, type ExecutionDispatchConfirmation } from "./execution-dispatch";
import { ModalBridgeError, type createModalBridgeClient } from "./modal-bridge";

/** Cold start is about 20 s at p95, so three minutes means a lost call, not a slow one. */
export const MODAL_ACQUISITION_DEADLINE_MS = 180_000;
export const MODAL_ACQUISITION_MAX_RESPAWNS = 3;
const ACQUISITION_CHECK = "ma1.";
export function isAcquisitionCheck(reference: ExecutionDispatchReference): boolean {
  return reference.kind === "maintenance" && reference.subject.kind === "maintenance" && reference.subject.id.startsWith(ACQUISITION_CHECK);
}

/** What a lost call's owner says about spawning for it. A restricted Workspace
 * keeps the work recoverable (the deadline still counts, a respawn does not);
 * a closed subject has nothing left to acquire. Other subjects have no domain state. */
async function acquisitionAuthority(database: PrismaClient, reference: ExecutionDispatchReference): Promise<"open" | "restricted" | "closed"> {
  const { subject } = reference;
  const workspaceOf = (workspace: { status: string }) => workspace.status === "active" ? "open" : "restricted";
  if (subject.kind === "ingest_job") {
    const job = await database.ingestJob.findUnique({ where: { id: subject.id }, select: { status: true, generation: true, project: { select: { workspace: { select: { status: true } } } } } });
    return !job || job.generation !== reference.generation || job.status === "completed" || job.status === "failed" || job.status === "cancelled" ? "closed" : workspaceOf(job.project.workspace);
  }
  if (subject.kind === "workflow_run") {
    const run = await database.workflowRun.findUnique({ where: { id: subject.id }, select: { status: true, generation: true, project: { select: { workspace: { select: { status: true } } } } } });
    return !run || run.generation !== reference.generation || ["completed", "partial", "failed", "cancelled"].includes(run.status) ? "closed" : workspaceOf(run.project.workspace);
  }
  if (subject.kind === "render_group") {
    const group = await database.renderGroup.findUnique({ where: { id: subject.id }, select: { status: true, workflowRun: { select: { project: { select: { workspace: { select: { status: true } } } } } } } });
    return !group || !["queued", "running"].includes(group.status) ? "closed" : workspaceOf(group.workflowRun.project.workspace);
  }
  return "open";
}

/** Resolve the already admitted tuple; a transport retry never invents a new
 * token or chooses arbitrarily between ambiguous admissions. */
export function createModalDispatch(database: PrismaClient, bridge: ReturnType<typeof createModalBridgeClient>) {
  return {
    async spawn(value: ExecutionDispatchReference): Promise<ExecutionDispatchConfirmation> {
      const reference = executionDispatchReferenceSchema.parse(value);
      if (reference.kind !== "modal_execution") throw new ExecutionDispatchError("invalid_dispatch");
      const admitted = await database.executionAttempt.findMany({ where: { dispatchId: reference.dispatchId,
        deploymentEpoch: reference.deploymentEpoch, generation: reference.generation, inputHash: reference.inputHash,
        dispatch: { kind: reference.kind, subjectKind: reference.subject.kind, subjectId: reference.subject.id } },
        select: { attemptToken: true, functionName: true }, take: 2 });
      if (admitted.length !== 1) throw new ExecutionDispatchError("invalid_dispatch");
      const attempt = admitted[0]!;
      const functionName = executionMediaFunctionSchema.safeParse(attempt.functionName);
      if (!functionName.success) throw new ExecutionDispatchError("invalid_dispatch");
      const result = await bridge.command({ action: "spawn", reference, attemptToken: attempt.attemptToken, function: functionName.data }, reference.dispatchId);
      if (result.disposition !== "spawned") throw new ExecutionDispatchError("invalid_confirmation");
      return { status: "confirmed_created", destinationId: result.callId };
    },

    /** The watchdog otherwise sees nothing until the operation deadline. One
     * Maintenance instance per spawned attempt polls the outcome below. */
    async watchAcquisition(value: ExecutionDispatchReference): Promise<string | null> {
      const reference = executionDispatchReferenceSchema.parse(value);
      const attempt = await database.executionAttempt.findFirst({ where: { dispatchId: reference.dispatchId }, select: { operationDeadlineAt: true } });
      if (reference.kind !== "modal_execution" || !attempt) return null;
      const check = await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: reference.deploymentEpoch, kind: "maintenance", generation: 1,
        subject: { kind: "maintenance", id: `${ACQUISITION_CHECK}${reference.dispatchId}` }, inputHash: reference.inputHash, dueAt: attempt.operationDeadlineAt }));
      return check.reference.dispatchId;
    },

    /** Returns when to look again, or null once nothing here can help: the attempt
     * acquired or closed, or its respawns are spent and the operation deadline
     * decides, or its owner closed. A restricted Workspace is looked at again later
     * and spends no respawn. A respawn reuses the exact token and reference, so acquire still
     * admits one owner. Each respawn is a ledger row whose id is its bridge delivery. */
    async recoverAcquisition(check: ExecutionDispatchReference): Promise<Date | null> {
      const ledger = await readExecutionDispatch(database, check.dispatchId);
      if (!isAcquisitionCheck(check) || !ledger || JSON.stringify(ledger.reference) !== JSON.stringify(check)) throw new ExecutionDispatchError("invalid_dispatch");
      const native = await readExecutionDispatch(database, check.subject.id.slice(ACQUISITION_CHECK.length));
      const attempt = native && await database.executionAttempt.findFirst({ where: { dispatchId: native.reference.dispatchId } });
      if (!native?.acknowledgedAt || !attempt || attempt.owner || attempt.status !== "admitted") return null;
      const { reference } = native, functionName = executionMediaFunctionSchema.parse(attempt.functionName);
      const authority = await acquisitionAuthority(database, reference);
      if (authority === "closed") return null;
      const respawns = await database.executionDispatch.findMany({ where: { deploymentEpoch: reference.deploymentEpoch, generation: reference.generation, subjectKind: reference.subject.kind,
        subjectId: reference.subject.id, kind: "operation_driver", wakeKind: { startsWith: "respawn_" } }, orderBy: { createdAt: "desc" } });
      const latest = respawns[0], unconfirmed = latest && !latest.acknowledgedAt ? latest : null;
      const [clock] = await database.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
      if (!clock) throw new ExecutionDispatchError("epoch_unavailable");
      const due = (latest?.createdAt ?? native.acknowledgedAt).getTime() + MODAL_ACQUISITION_DEADLINE_MS, again = new Date(clock.now.getTime() + MODAL_ACQUISITION_DEADLINE_MS);
      if (authority === "restricted") return again;
      if (!unconfirmed && due > clock.now.getTime()) return new Date(due);
      try {
        if (!unconfirmed) {
          // A bridge receipt is keyed by delivery, so every observation needs a fresh one.
          const observed = await bridge.command({ action: "status", reference, attemptToken: attempt.attemptToken, spawnDeliveryId: latest?.id ?? reference.dispatchId }, crypto.randomUUID());
          if (observed.disposition === "observed" && observed.state === "pending") return again;
          if (respawns.length >= MODAL_ACQUISITION_MAX_RESPAWNS) return null;
        }
        const delivery = unconfirmed?.id ?? (await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: reference.deploymentEpoch, kind: "operation_driver", subject: reference.subject,
          generation: reference.generation, inputHash: reference.inputHash, dueAt: attempt.operationDeadlineAt, wakeKind: `respawn_${respawns.length + 1}` }))).reference.dispatchId;
        const spawned = await bridge.command({ action: "spawn", reference, attemptToken: attempt.attemptToken, function: functionName }, delivery);
        if (spawned.disposition !== "spawned") throw new ExecutionDispatchError("invalid_confirmation");
        await database.executionDispatch.updateMany({ where: { id: delivery, acknowledgedAt: null }, data: { acknowledgedAt: clock.now, destinationId: spawned.callId } });
        console.warn(JSON.stringify({ level: "warn", message: "modal_acquisition_respawned", dispatchId: reference.dispatchId, delivery }));
        return again;
      } catch (error) {
        if (!(error instanceof ModalBridgeError)) throw error;
        console.warn(JSON.stringify({ level: "warn", message: "modal_acquisition_check_unavailable", dispatchId: reference.dispatchId, errorCode: error.code }));
        return again;
      }
    },
  };
}
