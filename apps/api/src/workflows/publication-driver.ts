import type { PublicationPreparation } from "@narriflow/services/publication-execution";
import type { ExecutorExpiryResult } from "@narriflow/services/executor-domain-control";
import type { ExecutionDispatchDeliveryResult } from "@narriflow/services/execution-dispatch";
import type { ExecutionDeadline, ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { WorkflowCommandHandler } from "./protocol";
import { createNativeOperationDriver } from "./native-operation-driver";

interface Ports {
  now(): number;
  prepare(reference: ExecutionDispatchReference): Promise<PublicationPreparation>;
  expire(deadline: ExecutionDeadline, deliveryId: string): Promise<ExecutorExpiryResult>;
  deliver(ids: readonly string[]): Promise<readonly ExecutionDispatchDeliveryResult[]>;
}
/** External pauses have no executor claim or product timeout. Targeted export
 * and grant changes wake this reference, including via independent delivery.
 * The365-day horizon is only Cloudflare's maximum event wait; it grants no
 * authority and a timeout rereads the current domain state. */
export function createPublicationDriver(ports: Ports): WorkflowCommandHandler {
  return async command => {
    const prepared = await ports.prepare(command.reference);
    if (prepared.kind === "waiting_export" || prepared.kind === "waiting_grant") return {
      type: "wait", until: new Date(ports.now()+365*86_400_000).toISOString(), deliveryId: command.reference.dispatchId };
    if (prepared.kind === "terminal" || prepared.kind === "superseded") return { type: "complete", disposition: prepared.kind };
    if (prepared.kind === "sleep") return { type: "sleep", until: prepared.dueAt.toISOString() };
    if (prepared.kind !== "waiting") throw Error("publication_preparation_invalid");
    return createNativeOperationDriver({ ...ports, prepare: async () => prepared })(command);
  };
}
