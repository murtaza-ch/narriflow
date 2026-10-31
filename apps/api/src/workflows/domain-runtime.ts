import { getExecutionDispatch } from "@narriflow/services/execution-dispatch-runtime";
import type { ApiWorkerBindings } from "../worker-bindings";
import { createWorkerExecutionScheduler } from "./scheduler";
import type { WorkflowCommandHandler, WorkflowHandlerRegistry } from "./protocol";

/** Domain owners install their targeted command handlers here. Missing kinds
 * fail explicitly in the entrypoint; there is no successful default handler. */
export function workflowDomainRegistry(bindings: ApiWorkerBindings): WorkflowHandlerRegistry {
  const progress: WorkflowCommandHandler = async ({ reference }) => {
    const outcome = await getExecutionDispatch(createWorkerExecutionScheduler(bindings)).deliver(reference.dispatchId);
    if (outcome.status === "acknowledged") return { type: "complete" as const, disposition: "terminal" as const };
    if (outcome.status === "superseded" || outcome.status === "missing") return { type: "complete" as const, disposition: "superseded" as const };
    if (outcome.status === "pending") return { type: "sleep" as const, until: outcome.retryAt.toISOString() };
    throw new Error(`Progress continuation ${outcome.status}`);
  };
  return { project_progress: { maintenance: progress, workflow_event: progress } };
}
