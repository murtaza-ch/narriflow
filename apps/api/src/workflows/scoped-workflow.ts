import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDatabaseScope, withDatabaseScope, type DatabaseScope } from "@narriflow/db/client";
import { executionDispatchIdentity } from "@narriflow/services/execution-dispatch";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { withWorkerServices, workerServiceEnvironment } from "../worker-services";
import type { ApiWorkerBindings } from "../worker-bindings";
import { workflowDomainRegistry } from "./domain-runtime";
import { assertMetadataBound, dispatchContinuationInstanceId, workflowDirectiveSchema, workflowDispatchEventSchema, WORKFLOW_DISPATCH_EVENT, type WorkflowHandlerRegistry, type WorkflowKind, type WorkflowWake } from "./protocol";

const MAX_COMMAND_STEPS = 512;
/** Only one command is inside a scope. Workflows, not JavaScript timers, owns
 * every wait. Values kept between commands are validated references/metadata. */
export abstract class ScopedDomainWorkflow extends WorkflowEntrypoint<ApiWorkerBindings, ExecutionDispatchReference> {
  protected abstract readonly workflowKind: WorkflowKind;
  protected registry(): WorkflowHandlerRegistry { return workflowDomainRegistry(this.env); }
  protected scope(): DatabaseScope { return createDatabaseScope({ connectionString: this.env.HYPERDRIVE.connectionString }); }

  override async run(event: Readonly<WorkflowEvent<ExecutionDispatchReference>>, step: WorkflowStep) {
    let reference: ExecutionDispatchReference;
    try { assertMetadataBound(event.payload); reference = executionDispatchReferenceSchema.parse(event.payload); }
    catch { throw new NonRetryableError("invalid_workflow_reference"); }
    const continuation = this.workflowKind === "maintenance" && event.instanceId === dispatchContinuationInstanceId(reference);
    if (!continuation && reference.kind !== this.workflowKind && !(this.workflowKind === "maintenance" && reference.kind === "project_progress")) throw new NonRetryableError("wrong_workflow_entrypoint");
    if (!continuation && event.instanceId !== (await executionDispatchIdentity(reference)).instanceId) throw new NonRetryableError("wrong_workflow_instance");
    let wake: WorkflowWake = { type: "start" };
    for (let index = 0; index < MAX_COMMAND_STEPS; index++) {
      const input = { reference, wake };
      const directive = await step.do(`command-${index}`, { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "2 minutes" }, () =>
        withWorkerServices(this.env, workerServiceEnvironment(this.env), () => withDatabaseScope(this.scope(), async () => {
          // Construct the registry after entering the new scope. A factory may
          // resolve service ports here but cannot retain a prior step's client.
          const handler = this.registry()[reference.kind]?.[reference.subject.kind];
          if (!handler) throw new NonRetryableError(`unsupported_workflow_subject:${reference.kind}:${reference.subject.kind}`);
          const output = await handler(input);
          try { assertMetadataBound(output); return workflowDirectiveSchema.parse(output); }
          catch { throw new NonRetryableError("invalid_workflow_directive"); }
        })),
      );
      if (directive.type === "complete") return { reference, disposition: directive.disposition };
      const until = new Date(directive.until).getTime();
      if (directive.type === "sleep") {
        await step.sleepUntil(`sleep-${index}`, until);
        wake = { type: "timer", until: directive.until };
        continue;
      }
      if (until <= Date.now()) {
        wake = { type: "deadline", until: directive.until, deliveryId: directive.deliveryId, ...(directive.deadline ? { deadline: directive.deadline } : {}) };
        continue;
      }
      let received;
      try {
        received = await step.waitForEvent(`wait-${index}`, { type: WORKFLOW_DISPATCH_EVENT, timeout: Math.max(1_000, until - Date.now()) });
      } catch (cause) {
        // A platform error before the observed deadline is not an expiry.
        if (Date.now() < until) throw cause;
        wake = { type: "deadline", until: directive.until, deliveryId: directive.deliveryId, ...(directive.deadline ? { deadline: directive.deadline } : {}) };
        continue;
      }
      try {
        assertMetadataBound(received.payload);
        const delivery = workflowDispatchEventSchema.parse(received.payload);
        if (delivery.reference.deploymentEpoch !== reference.deploymentEpoch || delivery.reference.generation !== reference.generation || delivery.reference.subject.kind !== reference.subject.kind || delivery.reference.subject.id !== reference.subject.id || delivery.reference.kind !== reference.kind || delivery.reference.inputHash !== reference.inputHash) throw new Error("scope mismatch");
        wake = { type: "dispatch", delivery };
      } catch { throw new NonRetryableError("invalid_workflow_wake"); }
    }
    throw new NonRetryableError("workflow_command_limit");
  }
}
