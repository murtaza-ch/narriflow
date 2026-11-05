import { ExecutionDispatchPendingError } from "@narriflow/services/execution-dispatch";
import { isExpectedDomainFailure } from "@narriflow/services/expected-domain-failure";
import { logFailure } from "@narriflow/services/log-failure";
import { WorkflowAttemptLost } from "@narriflow/services/workflow-attempt-contract";
import {runWorkflowCommand} from "./dispatch-retry";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDatabaseScope, withDatabaseScope, type DatabaseScope } from "@narriflow/db/client";
import { executionDispatchIdentity, executionDispatchRetryId } from "@narriflow/services/execution-dispatch";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { withWorkerServices, workerServiceEnvironment } from "../worker-services";
import { withExecutionDispatches } from "@narriflow/services/execution-dispatch-runtime";
import { canRunWhileFenced } from "./execution-fence";
import type { ApiWorkerBindings } from "../worker-bindings";
import { workflowDispatchRedelivery, workflowDomainRegistry } from "./domain-runtime";
import { assertMetadataBound, dispatchContinuationInstanceId, workflowDirectiveSchema, workflowDispatchEventSchema, WORKFLOW_COMMAND_STEP, WORKFLOW_DISPATCH_EVENT, type WorkflowHandlerRegistry, type WorkflowKind, type WorkflowWake } from "./protocol";

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
    if (this.env.ADMISSION_STATE === "fenced" && !canRunWhileFenced(reference)) throw new NonRetryableError("execution_fenced");
    const redelivery = this.workflowKind === "maintenance" && event.instanceId === executionDispatchRetryId(reference);
    const continuation = redelivery || (this.workflowKind === "maintenance" && event.instanceId === dispatchContinuationInstanceId(reference));
    if (!continuation && reference.kind !== this.workflowKind && !(this.workflowKind === "maintenance" && reference.kind === "project_progress")) throw new NonRetryableError("wrong_workflow_entrypoint");
    if (!continuation && event.instanceId !== (await executionDispatchIdentity(reference)).instanceId) throw new NonRetryableError("wrong_workflow_instance");
    let wake: WorkflowWake = { type: "start" };
    for (let index = 0; index < MAX_COMMAND_STEPS; index++) {
      const input = { reference, wake };
      const directive = await step.do(`command-${index}`, WORKFLOW_COMMAND_STEP, () => runWorkflowCommand(() =>
        withWorkerServices(this.env, workerServiceEnvironment(this.env), () => withDatabaseScope(this.scope(), () => withExecutionDispatches(async () => {
          // Construct the registry after entering the new scope. A factory may
          // resolve service ports here but cannot retain a prior step's client.
          try {
            const handler = redelivery ? workflowDispatchRedelivery(this.env) : this.registry()[reference.kind]?.[reference.subject.kind];
            if (!handler) throw new NonRetryableError(`unsupported_workflow_subject:${reference.kind}:${reference.subject.kind}`);
            const output = await handler(input);
            try { assertMetadataBound(output); return workflowDirectiveSchema.parse(output); }
            catch { throw new NonRetryableError("invalid_workflow_directive"); }
          } catch (failure) {
            // A pending delivery is a planned retry, a domain refusal is an answer, and a lost
            // attempt is the fence stopping a stale owner. None is a fault; the health check sees stuck work.
            if (!(failure instanceof ExecutionDispatchPendingError) && !(failure instanceof WorkflowAttemptLost) && !isExpectedDomainFailure(failure)) logFailure("workflow_command_failed", failure, { kind: reference.kind, subjectKind: reference.subject.kind });
            throw failure;
          }
        })))),
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
