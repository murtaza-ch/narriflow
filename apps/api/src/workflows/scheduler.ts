import { getPrismaClient } from "@narriflow/db/client";
import { getExecutionDispatch } from "@narriflow/services/execution-dispatch-runtime";
import { ExecutionDispatchError, type ExecutionDispatchConfirmation, type ExecutionDispatchScheduler } from "@narriflow/services/execution-dispatch";
import { deliverProgressDispatch } from "@narriflow/services/progress-outbox";
import { createModalDispatch } from "@narriflow/services/modal-dispatch";
import { createModalBridgeClient } from "@narriflow/services/modal-bridge";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { requireLocalFetchDevelopment } from "@narriflow/services/local-fetch-device";
import { executionKeyRing } from "../execution-keys";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ApiWorkerBindings } from "../worker-bindings";
import { assertMetadataBound, dispatchContinuationInstanceId, workflowDispatchEventSchema, WORKFLOW_DISPATCH_EVENT } from "./protocol";

const REGISTERED = new Set(["queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause"]);
/** A reconnect may redeliver an acknowledged mailbox message. Only the
 * database acquire command can grant the device an executor owner. */
export async function deliverLocalFetchReference(reference: ExecutionDispatchReference, bindings: ApiWorkerBindings): Promise<ExecutionDispatchConfirmation> {
  const database = getPrismaClient();
  if (!database || !bindings.LOCAL_FETCH_MAILBOX || reference.kind !== "local_fetch" || reference.subject.kind !== "ingest_job") throw new ExecutionDispatchError("scheduler_unavailable");
  const job = await database.ingestJob.findUnique({ where: { id: reference.subject.id }, include: { project: { select: { workspaceId: true } } } });
  if (!job || job.deploymentEpoch !== reference.deploymentEpoch || job.generation !== reference.generation || !["queued", "running"].includes(job.status) || job.jobType !== "link_import" ||
    !job.payload || Array.isArray(job.payload) || typeof job.payload !== "object" || job.payload.provider !== "youtube") throw new ExecutionDispatchError("invalid_dispatch");
  requireLocalFetchDevelopment(readServiceEnvironment(), job.project.workspaceId);
  const attempts = await database.executionAttempt.findMany({ where: { dispatchId: reference.dispatchId }, take: 2 });
  const attempt = attempts[0];
  if (attempts.length !== 1 || !attempt || attempt.inputHash !== reference.inputHash || attempt.functionName !== "fetch_source") throw new ExecutionDispatchError("invalid_dispatch");
  const confirmed = await bindings.LOCAL_FETCH_MAILBOX.getByName(job.project.workspaceId).deliver({ reference, attemptToken: attempt.attemptToken });
  return { status: "confirmed_notified", destinationId: confirmed.destinationId };
}
async function createConfirmed(binding: Workflow, id: string, reference: ExecutionDispatchReference): Promise<ExecutionDispatchConfirmation> {
  assertMetadataBound(reference);
  try {
    const instance = await binding.create({ id, params: reference });
    if (instance.id !== id) throw new ExecutionDispatchError("invalid_confirmation");
    return { status: "confirmed_created", destinationId: id };
  } catch (error) {
    // A create transport failure is ambiguous. Confirm independently rather
    // than interpreting every exception as an already-existing instance.
    try {
      const instance = await binding.get(id);
      const status = await instance.status();
      if (instance.id === id && REGISTERED.has(status.status)) return { status: "confirmed_existing", destinationId: id };
    } catch { /* Preserve the original registration failure. */ }
    throw error;
  }
}

/** Called in a request/command step's fresh scope. Only text settings and
 * bindings are captured; each SQL lookup resolves that invocation's client. */
export function createWorkerExecutionScheduler(bindings: ApiWorkerBindings): ExecutionDispatchScheduler {
  return {
    async deliver(delivery) {
      const reference = executionDispatchReferenceSchema.parse(delivery.reference);
      assertMetadataBound(delivery.reference);
      if (reference.kind === "project_progress") {
        const database = getPrismaClient();
        if (!database) throw new Error("Progress dispatch requires a database scope");
        try { return await deliverProgressDispatch(database, reference); }
        catch (cause) {
          // A known delivery failure registers its bounded retry immediately;
          // hourly safety reconciliation is recovery for abandoned gaps only.
          await registerProgressContinuations(bindings, [reference.dispatchId]);
          throw cause;
        }
      }
      if (reference.kind === "modal_execution") {
        if (delivery.mode !== "registration") throw new ExecutionDispatchError("invalid_dispatch");
        const database = getPrismaClient(), environment = readServiceEnvironment();
        const keyId = environment.MODAL_BRIDGE_KEY_ID, origin = environment.MODAL_BRIDGE_ORIGIN;
        if (!database || !keyId || !origin) throw new ExecutionDispatchError("scheduler_unavailable");
        const key = executionKeyRing(environment.MODAL_BRIDGE_KEYS_JSON).get(keyId);
        if (!key) throw new ExecutionDispatchError("scheduler_unavailable");
        return createModalDispatch(database, createModalBridgeClient({ origin, keyId, key })).spawn(reference);
      }
      if (reference.kind === "local_fetch") return deliverLocalFetchReference(reference, bindings);
      const binding = reference.kind === "import_pipeline" ? bindings.IMPORT_PIPELINE
        : reference.kind === "render_run" ? bindings.RENDER_RUN
        : reference.kind === "operation_driver" ? bindings.OPERATION_DRIVER
        : reference.kind === "maintenance" ? bindings.MAINTENANCE : null;
      if (!binding) throw new ExecutionDispatchError("scheduler_unavailable");
      const independent = () => createConfirmed(bindings.MAINTENANCE, dispatchContinuationInstanceId(reference), reference);
      if (delivery.deadlineKind !== null || /^(?:cancel_|stt_)[a-f0-9]{32}$/.test(delivery.wakeKind ?? "")) {
        const confirmed = await independent();
        return { ...confirmed, status: delivery.mode === "wake" ? "confirmed_notified" : confirmed.status };
      }
      if (delivery.mode === "registration") return createConfirmed(binding, delivery.instanceId, reference);
      const payload = workflowDispatchEventSchema.parse({ reference, wakeKind: delivery.wakeKind, deadlineKind: delivery.deadlineKind, observedDeadlineAt: delivery.observedDeadlineAt?.toISOString() ?? null });
      assertMetadataBound(payload);
      try {
        const instance = await binding.get(delivery.instanceId);
        await instance.sendEvent({ type: WORKFLOW_DISPATCH_EVENT, payload });
      } catch { /* The independently registered command owns delivery. */ }
      // sendEvent can acknowledge an event after the instance has closed. It
      // accelerates the original waiter, but only an independently confirmed
      // command guarantees that this committed obligation will be re-read.
      const confirmed = await independent();
      return { status: "confirmed_notified", destinationId: confirmed.destinationId };
    },
  };
}

/** Each progress page is a distinct bounded Maintenance invocation. A parent
 * page acknowledges only after all continuation instances are confirmed. */
export async function registerProgressContinuations(bindings: ApiWorkerBindings, ids: readonly string[]): Promise<void> {
  if (ids.length > 100) throw new Error("Progress continuation limit exceeded");
  const dispatch = getExecutionDispatch(createWorkerExecutionScheduler(bindings));
  for (const id of new Set(ids)) {
    const record = await dispatch.read(id);
    if (!record || record.reference.kind !== "project_progress") throw new Error("Progress continuation unavailable");
    await createConfirmed(bindings.MAINTENANCE, record.instanceId, record.reference);
  }
}
