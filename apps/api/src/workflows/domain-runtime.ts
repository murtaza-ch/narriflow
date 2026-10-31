import { deliverExecutionDispatches, getExecutionDispatch } from "@narriflow/services/execution-dispatch-runtime";
import { getPrismaClient } from "@narriflow/db/client";
import { readExecutionDispatch } from "@narriflow/services/execution-dispatch";
import { createExecutorControl } from "@narriflow/services/executor-control";
import { getNativeValidationService } from "@narriflow/services/native-validation-runtime";
import { getThumbnailFrameExecution } from "@narriflow/services/thumbnail-frame-preparation-runtime";
import { getOutboundProbeService } from "@narriflow/services/outbound-probe-runtime";
import { getWorkflowRunLifecycle } from "@narriflow/services/workflow-run-lifecycle";
import { getTranscriptionControl } from "@narriflow/services/transcription-control-runtime";
import { continueScribeCapacityRelease } from "@narriflow/services/transcription-admission";
import { executionDeadlineSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { NonRetryableError } from "cloudflare:workflows";
import type { ApiWorkerBindings } from "../worker-bindings";
import { createWorkerExecutor } from "../domains/execution/runtime";
import { createWorkerExecutionScheduler } from "./scheduler";
import type { WorkflowCommandHandler, WorkflowHandlerRegistry } from "./protocol";
import { createNativeOperationDriver } from "./native-operation-driver";

function nativeDomain(reference: ExecutionDispatchReference) {
  if (reference.subject.kind === "native_validation") return getNativeValidationService();
  if (reference.subject.kind === "thumbnail_frame") return getThumbnailFrameExecution();
  if (reference.subject.kind === "outbound_probe") return getOutboundProbeService();
  throw new NonRetryableError("unsupported_native_subject");
}

/** Domain owners install their targeted command handlers here. Missing kinds
 * fail explicitly in the entrypoint; there is no successful default handler. */
export function workflowDomainRegistry(bindings: ApiWorkerBindings): WorkflowHandlerRegistry {
  const native: WorkflowCommandHandler = async command => {
    const database = getPrismaClient();
    if (!database) throw new Error("Native driver requires a database scope");
    const record = await readExecutionDispatch(database, command.reference.dispatchId);
    if (!record || JSON.stringify(record.reference) !== JSON.stringify(command.reference)) return { type: "complete", disposition: "superseded" };
    if (record.deadlineKind) {
      if (record.deadlineKind !== "lease" && record.deadlineKind !== "operation") throw new NonRetryableError("unsupported_native_deadline");
      if (!record.observedDeadlineAt) throw new NonRetryableError("missing_native_deadline");
      if (record.observedDeadlineAt.getTime() > Date.now()) return { type: "sleep", until: record.observedDeadlineAt.toISOString() };
      const attempts = await database.executionAttempt.findMany({ where: { deploymentEpoch: record.reference.deploymentEpoch,
        generation: record.reference.generation, inputHash: record.reference.inputHash,
        dispatch: { subjectKind: record.reference.subject.kind, subjectId: record.reference.subject.id, kind: "modal_execution" } }, take: 2 });
      if (!attempts.length) return { type: "complete", disposition: "superseded" };
      if (attempts.length !== 1) throw new NonRetryableError("ambiguous_native_admission");
      const attempt = attempts[0]!;
      const target = await readExecutionDispatch(database, attempt.dispatchId);
      if (!target) return { type: "complete", disposition: "superseded" };
      const deadline = executionDeadlineSchema.parse({ reference: target.reference, attemptToken: attempt.attemptToken,
        kind: record.deadlineKind, observedDeadlineAt: record.observedDeadlineAt.toISOString() });
      const control = createExecutorControl({ database, subjectKind: command.reference.subject.kind, domain: nativeDomain(command.reference), deliverWakes: deliverExecutionDispatches });
      const outcome = await control.expireDeadline({ deadline, deliveryId: record.reference.dispatchId });
      return outcome.kind === "sleep" ? { type: "sleep", until: outcome.dueAt.toISOString() }
        : { type: "complete", disposition: outcome.kind === "superseded" ? "superseded" : "terminal" };
    }
    return createNativeOperationDriver({ now: Date.now, prepare: reference => nativeDomain(reference).prepareExecution(reference),
      expire: (deadline, deliveryId) => createWorkerExecutor(deadline.reference, bindings).control.expireDeadline({ deadline, deliveryId }),
      deliver: ids => Promise.all(ids.map(id => getExecutionDispatch().deliver(id))),
    })(command);
  };
  const workflow: WorkflowCommandHandler = async ({ reference }) => {
    const database = getPrismaClient();
    if (!database) throw new Error("Operation driver requires a database scope");
    const record = await readExecutionDispatch(database, reference.dispatchId);
    if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference)) return { type: "complete", disposition: "superseded" };
    if (/^cancel_[a-f0-9]{32}$/.test(record.wakeKind ?? "")) {
      await deliverExecutionDispatches((await getWorkflowRunLifecycle().continueSourceCancellation(reference)).dispatchIds);
      return { type: "complete", disposition: "terminal" };
    }
    if (/^stt_[a-f0-9]{32}$/.test(record.wakeKind ?? "")) {
      await deliverExecutionDispatches((await continueScribeCapacityRelease(database, reference)).dispatchIds);
      return { type: "complete", disposition: "terminal" };
    }
    if (record.deadlineKind && record.observedDeadlineAt && record.observedDeadlineAt.getTime() > Date.now()) return { type: "sleep", until: record.observedDeadlineAt.toISOString() };
    const run = await database.workflowRun.findUnique({ where: { id: reference.subject.id } });
    if (!run || run.deploymentEpoch !== reference.deploymentEpoch || run.generation !== reference.generation) return { type: "complete", disposition: "superseded" };
    if (["completed", "cancelled", "failed"].includes(run.status)) return { type: "complete", disposition: "terminal" };
    if (run.stage !== "stt") throw new NonRetryableError(`unsupported_operation_stage:${run.stage}`);
    const result = await getTranscriptionControl().run(reference);
    if (result.kind === "complete") return { type: "complete", disposition: result.disposition === "superseded" ? "superseded" : "terminal" };
    if (result.kind === "wait") return { type: "wait", until: result.dueAt.toISOString(), deliveryId: reference.dispatchId };
    // This can only precede the Source Audio handoff; no TS owner is acquired.
    const until = new Date(run.createdAt.getTime() + 45 * 60_000);
    if (until.getTime() <= Date.now()) throw new NonRetryableError("source_audio_handoff_missing");
    return { type: "wait", until: until.toISOString(), deliveryId: reference.dispatchId };
  };
  const progress: WorkflowCommandHandler = async ({ reference }) => {
    const outcome = await getExecutionDispatch(createWorkerExecutionScheduler(bindings)).deliver(reference.dispatchId);
    if (outcome.status === "acknowledged") return { type: "complete" as const, disposition: "terminal" as const };
    if (outcome.status === "superseded" || outcome.status === "missing") return { type: "complete" as const, disposition: "superseded" as const };
    if (outcome.status === "pending") return { type: "sleep" as const, until: outcome.retryAt.toISOString() };
    throw new Error(`Progress continuation ${outcome.status}`);
  };
  return { project_progress: { maintenance: progress, workflow_event: progress },
    operation_driver: { native_validation: native, thumbnail_frame: native, outbound_probe: native, workflow_run: workflow } };
}
