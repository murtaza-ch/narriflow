import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { executionDispatchIdentity, type ExecutionDispatchScheduler } from "../src/execution-dispatch";
import { restoreWorkflowTarget } from "../src/execution-restore-operator";

const refuse = (): never => { throw Error("gate_cleanup_registration_unconfirmed"); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export function cleanupWorkflowTarget(config: unknown, configPath: string) {
  if (!object(config) || config.name !== "narriflow-api-candidate" || !object(config.vars) || config.vars.ADMISSION_STATE !== "closed" ||
    !object(config.triggers) || !Array.isArray(config.triggers.crons) || config.triggers.crons.length !== 0) return refuse();
  return { ...restoreWorkflowTarget(config), configPath };
}

/** Gate-only registration of the producer's exact known-row mc1 references.
 * The Worker owns the drain, cleanup claim, confirmed lease timer and DELETE. */
export function createGateCleanupScheduler(input: {
  target: ReturnType<typeof cleanupWorkflowTarget>;
  references: readonly ExecutionDispatchReference[];
  run(args: readonly string[]): Promise<unknown>;
}): ExecutionDispatchScheduler {
  const known = new Map(input.references.map(reference => [reference.dispatchId, reference]));
  const statuses = new Set(["queued", "running", "waiting", "paused", "waitingForPause", "rollingBack", "complete", "errored", "terminated"]);
  return { async deliver(delivery) {
    const reference = delivery.reference, expected = await executionDispatchIdentity(reference);
    const range = /^mc1\.(0|[1-9][0-9]{0,12})\.([a-f0-9]{32})\.(0|[1-9][0-9]{0,12})\.([a-f0-9]{32})$/.exec(reference.subject.id);
    if (JSON.stringify(known.get(reference.dispatchId)) !== JSON.stringify(reference) || reference.kind !== "maintenance" || reference.subject.kind !== "maintenance" ||
      reference.generation !== 1 || !range || range[1] !== range[3] || range[2] !== range[4] || delivery.mode !== "registration" || delivery.wakeKind || delivery.deadlineKind ||
      delivery.instanceId !== expected.instanceId || delivery.deliveryKey !== expected.deliveryKey) return refuse();
    const common = ["--config", input.target.configPath, "--json"];
    try {
      const value = await input.run(["workflows", "trigger", input.target.workflowName, JSON.stringify(reference), "--id", expected.instanceId, ...common]);
      if (object(value) && value.id === expected.instanceId) return { status: "confirmed_created", destinationId: expected.instanceId };
    } catch { /* A lost trigger response requires an independent exact-ID read. */ }
    const existing = await input.run(["workflows", "instances", "describe", input.target.workflowName, expected.instanceId, ...common]);
    if (!object(existing) || existing.id !== expected.instanceId || typeof existing.status !== "string" || !statuses.has(existing.status)) return refuse();
    return { status: "confirmed_existing", destinationId: expected.instanceId };
  } };
}
