import type { ExecutionDeadline, ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { NativeValidationPreparation } from "@narriflow/services/native-validation";
import type { ExecutorExpiryResult } from "@narriflow/services/executor-domain-control";
import { ExecutionDispatchPendingError, type ExecutionDispatchDeliveryResult } from "@narriflow/services/execution-dispatch";
import type { WorkflowCommandHandler } from "./protocol";

interface Ports {
  prepare(reference: ExecutionDispatchReference): Promise<NativeValidationPreparation>;
  expire(deadline: ExecutionDeadline, deliveryId: string): Promise<ExecutorExpiryResult>;
  deliver(ids: readonly string[]): Promise<readonly ExecutionDispatchDeliveryResult[]>;
  now(): number;
}

/** The step returns references and a timer only. Native work and renewable
 * ownership remain outside the coordinator. */
export function createNativeOperationDriver(ports: Ports): WorkflowCommandHandler {
  return async ({ reference }) => {
    const prepared = await ports.prepare(reference);
    if (prepared.kind === "sleep") return { type: "sleep", until: prepared.dueAt.toISOString() };
    if (prepared.kind === "dependency_wait") {
      for (const ids of [[prepared.deadlineDispatchId], prepared.dispatchIds.filter(id => id !== prepared.deadlineDispatchId)]) {
        const results = await ports.deliver(ids);
        const pending = results.filter((result): result is Extract<ExecutionDispatchDeliveryResult, { status: "pending" }> => result.status === "pending");
        if (results.some(result => !["acknowledged", "superseded", "pending"].includes(result.status))) throw new Error("native_dispatch_unavailable");
        if (pending.length) throw new ExecutionDispatchPendingError(new Date(Math.min(prepared.dueAt.getTime(), ...pending.map(result => result.retryAt.getTime()))));
      }
      return { type: "wait", until: prepared.dueAt.toISOString(), deliveryId: prepared.deadlineDispatchId };
    }
    if (prepared.kind !== "waiting") return { type: "complete", disposition: prepared.kind };
    let deadline = prepared.deadline;
    if (Date.parse(deadline.observedDeadlineAt) <= ports.now()) {
      const expiry = await ports.expire(deadline, prepared.deliveryId);
      if (expiry.kind !== "sleep") return { type: "complete", disposition: expiry.kind === "superseded" ? "superseded" : "terminal" };
      deadline = { ...deadline, observedDeadlineAt: expiry.dueAt.toISOString() };
    }
    // Confirm the independent watchdog before sending any heavy invocation.
    // A known failed registration parks on its own persisted retry time.
    for (const ids of [[prepared.deliveryId], prepared.dispatchIds.filter(id => id !== prepared.deliveryId)]) {
      const results = await ports.deliver(ids);
      const pending = results.filter((result): result is Extract<ExecutionDispatchDeliveryResult, { status: "pending" }> => result.status === "pending");
      if (results.some(result => !["acknowledged", "superseded", "pending"].includes(result.status))) throw new Error("native_dispatch_unavailable");
      if (pending.length) throw new ExecutionDispatchPendingError(new Date(Math.min(Date.parse(deadline.observedDeadlineAt), ...pending.map(result => result.retryAt.getTime()))));
    }
    return { type: "wait", until: deadline.observedDeadlineAt, deliveryId: prepared.deliveryId, deadline };
  };
}
