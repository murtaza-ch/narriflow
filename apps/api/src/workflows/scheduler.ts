import { getPrismaClient } from "@narriflow/db/client";
import { getExecutionDispatch } from "@narriflow/services/execution-dispatch-runtime";
import { ExecutionDispatchError, type ExecutionDispatchConfirmation, type ExecutionDispatchScheduler } from "@narriflow/services/execution-dispatch";
import { deliverProgressDispatch } from "@narriflow/services/progress-outbox";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ApiWorkerBindings } from "../worker-bindings";
import { assertMetadataBound, workflowDispatchEventSchema, WORKFLOW_DISPATCH_EVENT } from "./protocol";

const REGISTERED = new Set(["queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause"]);
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
      const binding = reference.kind === "import_pipeline" ? bindings.IMPORT_PIPELINE
        : reference.kind === "render_run" ? bindings.RENDER_RUN
        : reference.kind === "operation_driver" ? bindings.OPERATION_DRIVER
        : reference.kind === "maintenance" ? bindings.MAINTENANCE : null;
      if (!binding) throw new ExecutionDispatchError("scheduler_unavailable");
      if (delivery.mode === "registration") return createConfirmed(binding, delivery.instanceId, reference);
      const payload = workflowDispatchEventSchema.parse({ reference, wakeKind: delivery.wakeKind, deadlineKind: delivery.deadlineKind, observedDeadlineAt: delivery.observedDeadlineAt?.toISOString() ?? null });
      assertMetadataBound(payload);
      const instance = await binding.get(delivery.instanceId);
      await instance.sendEvent({ type: WORKFLOW_DISPATCH_EVENT, payload });
      return { status: "confirmed_notified", destinationId: delivery.instanceId };
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
