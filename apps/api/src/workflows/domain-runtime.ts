import {getNotificationExecution} from "@narriflow/services/notification-execution-runtime";
import {getGenerationFinishing} from "@narriflow/services/generation-finishing-runtime";
import { deliverExecutionDispatches, getExecutionDispatch } from "@narriflow/services/execution-dispatch-runtime";
import { getPrismaClient } from "@narriflow/db/client";
import { readExecutionDispatch, type ExecutionDispatchRecord } from "@narriflow/services/execution-dispatch";
import type { ExecutorExpiryResult } from "@narriflow/services/executor-domain-control";
import { getNativeValidationService } from "@narriflow/services/native-validation-runtime";
import { getThumbnailFrameExecution } from "@narriflow/services/thumbnail-frame-preparation-runtime";
import { getOutboundProbeService } from "@narriflow/services/outbound-probe-runtime";
import { getOutboundDeliveryService } from "@narriflow/services/outbound-delivery-runtime";
import { getClipSelectionControl } from "@narriflow/services/clip-selection-runtime";
import { getGeneratedMediaExecution } from "@narriflow/services/generated-media-runtime";
import { getClipPreparationService } from "@narriflow/services/clip-preparation-runtime";
import { getBillingReconciliation } from "@narriflow/services/billing-reconciliation-runtime";
import { getMediaCleanupControl, getMediaCleanupDrain } from "@narriflow/services/media-cleanup-runtime";
import { getPublicationExecution } from "@narriflow/services/publication-execution-runtime";
import { getPublicationObservations } from "@narriflow/services/publication-observations-runtime";
import { isPublicationObservationReference } from "@narriflow/services/publication-observations";
import { expireExportBundle, exportBundleExpiryInputHash } from "@narriflow/services/export-bundle-expiry";
import { readExecutionAdmission } from "@narriflow/services/execution-admission";
import { createFinishingProducers, isFinishingProducerReference } from "@narriflow/services/generation-finishing-producers";
import { createPublicationProducers, isPublicationProducerReference } from "@narriflow/services/publication-producers";
import { getLibraryIndex } from "@narriflow/services/library-index-runtime";
import { getAutopilotExecution } from "@narriflow/services/autopilot-execution-runtime";
import { getZoomNotificationExecution } from "@narriflow/services/zoom-execution-runtime";
import { createWorkspaceNotificationDispatcher, isCurrentNotificationTarget } from "@narriflow/services/notification-dispatch";
import { prepareIngestSourceExecution } from "@narriflow/services/ingest-source-execution";
import { getIngestJobLifecycle } from "@narriflow/services/ingest-job-lifecycle-runtime";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { getWorkflowRunLifecycle } from "@narriflow/services/workflow-run-lifecycle";
import { getTranscriptionControl } from "@narriflow/services/transcription-control-runtime";
import { continueScribeCapacityRelease } from "@narriflow/services/transcription-admission";
import { executionDeadlineSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { NonRetryableError } from "cloudflare:workflows";
import type { ApiWorkerBindings } from "../worker-bindings";
import { createWorkerExecutor, getWorkerRenderGroupService, getWorkerWorkflowRunService } from "../domains/execution/runtime";
import { createWorkerExecutionScheduler } from "./scheduler";
import type { WorkflowCommandHandler, WorkflowHandlerRegistry } from "./protocol";
import { createNativeOperationDriver } from "./native-operation-driver";
import { createPublicationDriver } from "./publication-driver";
import { createRenderRunDriver } from "./render-run-driver";
import { getWorkerMaintenanceRuntime } from "./maintenance-runtime";

async function nativeDomain(reference: ExecutionDispatchReference, bindings: ApiWorkerBindings) {
  if (reference.subject.kind === "native_validation") return getNativeValidationService();
  if (reference.subject.kind === "thumbnail_frame") return getThumbnailFrameExecution();
  if (reference.subject.kind === "outbound_probe") return getOutboundProbeService();
  if (reference.subject.kind === "outbound_delivery") return getOutboundDeliveryService();
  if (reference.subject.kind === "generated_media") return getGeneratedMediaExecution();
  if (reference.subject.kind === "clip_preparation") return getClipPreparationService();
  if (reference.subject.kind === "render_group") return getWorkerRenderGroupService(bindings.MEDIA_BUCKET);
  if (reference.subject.kind === "workflow_run") return (await getWorkerWorkflowRunService(reference, bindings.MEDIA_BUCKET)).domain;
  throw new NonRetryableError("unsupported_native_subject");
}

/** Domain owners install their targeted command handlers here. Missing kinds
 * fail explicitly in the entrypoint; there is no successful default handler. */
export function workflowDomainRegistry(bindings: ApiWorkerBindings): WorkflowHandlerRegistry {
  const expireNativeDeadline = async (record: ExecutionDispatchRecord): Promise<ExecutorExpiryResult> => {
    const database = getPrismaClient();
    if (!database) throw new Error("Native deadline requires a database scope");
    if (record.deadlineKind !== "lease" && record.deadlineKind !== "operation") throw new NonRetryableError("unsupported_native_deadline");
    if (!record.observedDeadlineAt) throw new NonRetryableError("missing_native_deadline");
    if (record.observedDeadlineAt.getTime() > Date.now()) return { kind: "sleep", dueAt: record.observedDeadlineAt };
    let attemptToken: string | undefined;
    let unownedExpiry: ExecutorExpiryResult | undefined;
    if (record.reference.subject.kind === "workflow_run" && record.deadlineKind === "operation") {
      const service = (await getWorkerWorkflowRunService(record.reference, bindings.MEDIA_BUCKET)).domain;
      const expiry = await service.expirePreparationDeadline(record.reference,{ kind: "operation", observedDeadlineAt: record.observedDeadlineAt });
      if (expiry.kind === "native") attemptToken = expiry.attemptToken;
      else {
        if (expiry.kind === "sleep") return expiry;
        unownedExpiry = expiry;
        if ("dispatchIds" in expiry) await deliverExecutionDispatches(expiry.dispatchIds ?? []);
      }
    }
    if (record.reference.subject.kind === "render_group" && record.deadlineKind === "operation") {
      const service = await getWorkerRenderGroupService(bindings.MEDIA_BUCKET);
      const expiry = await service.domain.expirePreparationDeadline(record.reference, { kind: "operation", observedDeadlineAt: record.observedDeadlineAt });
      if (expiry.kind === "native") attemptToken = expiry.attemptToken;
      else {
        if (expiry.kind === "sleep") return expiry;
        unownedExpiry = expiry;
        if ("dispatchIds" in expiry) await deliverExecutionDispatches(expiry.dispatchIds ?? []);
      }
    }
    const attempts = await database.executionAttempt.findMany({ where: { ...(attemptToken ? { attemptToken } : {}), deploymentEpoch: record.reference.deploymentEpoch,
      generation: record.reference.generation, inputHash: record.reference.inputHash,
      dispatch: { subjectKind: record.reference.subject.kind, subjectId: record.reference.subject.id, kind: { in: ["modal_execution", "local_fetch"] } } }, take: 2 });
    if (!attempts.length) return unownedExpiry ?? { kind: "superseded" };
    if (attempts.length !== 1) throw new NonRetryableError("ambiguous_native_admission");
    const attempt = attempts[0]!;
    const target = await readExecutionDispatch(database, attempt.dispatchId);
    if (!target) return { kind: "superseded" };
    const deadline = executionDeadlineSchema.parse({ reference: target.reference, attemptToken: attempt.attemptToken,
      kind: record.deadlineKind, observedDeadlineAt: record.observedDeadlineAt.toISOString() });
    return (await createWorkerExecutor(target.reference, bindings)).control.expireDeadline({ deadline, deliveryId: record.reference.dispatchId });
  };
  const native: WorkflowCommandHandler = async command => {
    const database = getPrismaClient();
    if (!database) throw new Error("Native driver requires a database scope");
    const record = await readExecutionDispatch(database, command.reference.dispatchId);
    if (!record || JSON.stringify(record.reference) !== JSON.stringify(command.reference)) return { type: "complete", disposition: "superseded" };
    if (command.reference.kind === "import_pipeline" && command.reference.subject.kind === "ingest_job") {
      const handoff = await getIngestJobLifecycle().handoffGeneration(command.reference);
      await deliverExecutionDispatches(handoff.dispatchIds);
      if (handoff.kind === "deferred") {
        if (!handoff.retryAt) throw new Error("ingest_handoff_retry_missing");
        return { type: "sleep", until: handoff.retryAt.toISOString() };
      }
    }
    if (record.deadlineKind) {
      const outcome = await expireNativeDeadline(record);
      if ("dispatchIds" in outcome) await deliverExecutionDispatches(outcome.dispatchIds ?? []);
      return outcome.kind === "sleep" ? { type: "sleep", until: outcome.dueAt.toISOString() }
        : { type: "complete", disposition: outcome.kind === "superseded" ? "superseded" : "terminal" };
    }
    return createNativeOperationDriver({ now: Date.now, prepare: async reference => {
      if (reference.subject.kind !== "ingest_job") return (await nativeDomain(reference, bindings)).prepareExecution(reference);
      const job = await database.ingestJob.findUnique({ where: { id: reference.subject.id }, select: { jobType: true, payload: true } });
      if (!job) return { kind: "superseded" };
      const environment = readServiceEnvironment();
      const local = environment.YOUTUBE_FETCH_MODE === "local" && job.jobType === "link_import" && job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) && job.payload.provider === "youtube";
      const toolchainFingerprint = (local ? environment.MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT : environment.MEDIA_FETCH_TOOLCHAIN_FINGERPRINT) ?? "";
      return prepareIngestSourceExecution({ database, domain: getIngestJobLifecycle(), reference, toolchainFingerprint, executionKind: local ? "local_fetch" : "modal_execution" });
    },
      expire: async (deadline, deliveryId) => (await createWorkerExecutor(deadline.reference, bindings)).control.expireDeadline({ deadline, deliveryId }),
      deliver: ids => Promise.all(ids.map(id => getExecutionDispatch().deliver(id))),
    })(command);
  };
  const render: WorkflowCommandHandler = command => createRenderRunDriver({ now: Date.now,
    prepare: reference => getWorkflowRunLifecycle().prepareRenderRun(reference),
    settle: reference => getWorkflowRunLifecycle().settleRenderRun(reference),
    deliver: deliverExecutionDispatches,
    expire: async observation => {
      const database = getPrismaClient();
      if (!database) throw new Error("Render deadline requires a database scope");
      const record = await readExecutionDispatch(database, observation.reference.dispatchId);
      if (!record || JSON.stringify(record.reference) !== JSON.stringify(observation.reference) || record.deadlineKind !== "operation" ||
        record.observedDeadlineAt?.getTime() !== observation.observedDeadlineAt.getTime()) return { kind: "superseded" };
      return expireNativeDeadline(record);
    },
  })(command);
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
    if (run.stage === "export_bundle" || run.stage === "dubbing") return native({ reference, wake: { type: "start" } });
    // Completed selection replays also repair the committed render/progress wakes.
    if (run.stage === "moment_detection") {
      const result = await getClipSelectionControl().runParent(reference);
      return result.kind === "wait" ? { type: "wait", until: result.dueAt.toISOString(), deliveryId: reference.dispatchId }
        : { type: "complete", disposition: result.outcome === "superseded" ? "superseded" : "terminal" };
    }
    if (run.stage === "stt" && run.status === "completed") {
      await deliverExecutionDispatches(await database.$transaction(tx => getWorkflowRunLifecycle().readCompletedTranscriptionWakesWithinTransaction(tx, reference)));
      return { type: "complete", disposition: "terminal" };
    }
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
  const selectionWindow: WorkflowCommandHandler = async ({ reference }) => {
    const result = await getClipSelectionControl().runWindow(reference);
    return result.kind === "wait" ? { type: "wait", until: result.dueAt.toISOString(), deliveryId: reference.dispatchId }
      : { type: "complete", disposition: result.outcome === "superseded" ? "superseded" : "terminal" };
  };
  const billing: WorkflowCommandHandler = async ({ reference }) => {
    const result = await getBillingReconciliation().run(reference);
    if (result.kind === "sleep") return { type: "sleep", until: result.dueAt.toISOString() };
    if (result.kind === "wait") return { type: "wait", until: result.dueAt.toISOString(), deliveryId: reference.dispatchId };
    return { type: "complete", disposition: result.kind === "superseded" ? "superseded" : "terminal" };
  };
  const library: WorkflowCommandHandler = async ({ reference }) => {
    const result = await getLibraryIndex().run(reference);
    if (result.kind === "sleep") return { type: "sleep", until: result.dueAt.toISOString() };
    if (result.kind === "wait") return { type: "wait", until: result.dueAt.toISOString(), deliveryId: reference.dispatchId };
    return { type: "complete", disposition: result.kind === "superseded" ? "superseded" : "terminal" };
  };
  const notification: WorkflowCommandHandler = async ({ reference }) => {
    const database = getPrismaClient();
    if (!database) throw new Error("Notification driver requires a database scope");
    const record = await readExecutionDispatch(database, reference.dispatchId);
    const epoch = await database.executionEpoch.findUnique({ where: { id: 1 } });
    if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference) || epoch?.epoch !== reference.deploymentEpoch) return { type: "complete", disposition: "superseded" };
    if (!await isCurrentNotificationTarget(database, reference)) return { type: "complete", disposition: "superseded" };
    const service = getOutboundDeliveryService();
    if (reference.subject.kind === "completion_callback") {
      await service.prepareCompletion(reference.subject.id, reference);
      return { type: "complete", disposition: "terminal" };
    }
    const result = await service.prepareSubscription(reference.subject.id, reference);
    return result.kind === "sleep" ? { type: "sleep", until: result.dueAt.toISOString() } : { type: "complete", disposition: "terminal" };
  };
  const notificationEvents: WorkflowCommandHandler = async ({ reference }) => {
    const database = getPrismaClient();
    if (!database) throw new Error("Notification dispatcher requires a database scope");
    if (reference.subject.kind === "maintenance" && !reference.subject.id.startsWith("wn1.")) throw new NonRetryableError("unsupported_notification_maintenance");
    await createWorkspaceNotificationDispatcher({ database, deliver: deliverExecutionDispatches }).dispatch(reference);
    return { type: "complete", disposition: "terminal" };
  };
  const finishing:WorkflowCommandHandler=async({reference})=>{
    const result=await getGenerationFinishing().run(reference);
    if(result.kind==="wait")return{type:"wait",until:result.dueAt.toISOString(),deliveryId:reference.dispatchId};
    if(result.kind==="sleep")return{type:"sleep",until:result.dueAt.toISOString()};
    return{type:"complete",disposition:result.kind==="superseded"?"superseded":"terminal"};
  };
  const emailNotification:WorkflowCommandHandler=async({reference})=>{
    const result=await getNotificationExecution().run(reference);
    if(result.kind==="wait")return{type:"wait",until:result.dueAt.toISOString(),deliveryId:reference.dispatchId};
    if(result.kind==="sleep")return{type:"sleep",until:result.dueAt.toISOString()};
    return{type:"complete",disposition:result.kind==="superseded"?"superseded":"terminal"};
  };
  const autopilot: WorkflowCommandHandler = async ({ reference }) => {
    const result = await getAutopilotExecution().run(reference);
    if (result.kind === "wait") return { type: "wait", until: result.dueAt.toISOString(), deliveryId: reference.dispatchId };
    if (result.kind === "sleep") return { type: "sleep", until: result.dueAt.toISOString() };
    return { type: "complete", disposition: result.kind === "superseded" ? "superseded" : "terminal" };
  };
  const zoomNotification: WorkflowCommandHandler = async ({ reference }) => {
    const result = await getZoomNotificationExecution().run(reference);
    if (result.kind === "wait") return { type: "wait", until: result.dueAt.toISOString(), deliveryId: reference.dispatchId };
    if (result.kind === "sleep") return { type: "sleep", until: result.dueAt.toISOString() };
    return { type: "complete", disposition: result.kind === "superseded" ? "superseded" : "terminal" };
  };
  const maintenancePage: WorkflowCommandHandler = async ({ reference }) => {
    const result = await (await getWorkerMaintenanceRuntime()).run(reference);
    return result.kind === "sleep" ? { type: "sleep", until: result.dueAt.toISOString() } : { type: "complete", disposition: "terminal" };
  };
  const cleanup: WorkflowCommandHandler = async ({ reference }) => {
    const result = await getMediaCleanupControl().run(reference);
    return result.kind === "wait" ? { type: "wait", until: result.until.toISOString(), deliveryId: reference.dispatchId }
      : { type: "complete", disposition: result.kind === "superseded" ? "superseded" : "terminal" };
  };
  const publication = createPublicationDriver({ now: Date.now,
    prepare: reference => getPublicationExecution().prepareExecution(reference),
    expire: async (deadline, deliveryId) => (await createWorkerExecutor(deadline.reference,bindings)).control.expireDeadline({ deadline, deliveryId }),
    deliver: ids => Promise.all(ids.map(id => getExecutionDispatch().deliver(id))),
  });
  const maintenance: WorkflowCommandHandler = async ({ reference }) => {
    if (/^(?:mt1|rs2|pr1|pw1)\./.test(reference.subject.id)) return maintenancePage({ reference, wake: { type: "start" } });
    if (isFinishingProducerReference(reference)) {
      const database = getPrismaClient();
      if (!database) throw Error("Finishing producer requires a database scope");
      const result = await createFinishingProducers({database,register:deliverExecutionDispatches}).dispatch(reference);
      return {type:"complete",disposition:result.kind==="superseded"?"superseded":"terminal"};
    }
    if (isPublicationObservationReference(reference)) {
      const result = await getPublicationObservations().dispatch(reference);
      if (result.kind === "sleep") {
        if (!result.dueAt) throw Error("publication_observation_due_missing");
        return { type: "sleep", until: result.dueAt.toISOString() };
      }
      return { type: "complete", disposition: result.kind === "superseded" ? "superseded" : "terminal" };
    }
    if (isPublicationProducerReference(reference)) {
      const database=getPrismaClient();
      if (!database) throw Error("Publication producer requires a database scope");
      const result=await createPublicationProducers({database,register:deliverExecutionDispatches}).dispatch(reference);
      if (result.kind === "sleep") {
        if (!result.dueAt) throw Error("publication_producer_due_missing");
        return {type:"sleep",until:result.dueAt.toISOString()};
      }
      return {type:"complete",disposition:result.kind==="superseded"?"superseded":"terminal"};
    }
    if (!reference.subject.id.startsWith("mc1.")) throw new NonRetryableError("unsupported_maintenance_subject");
    const result = await getMediaCleanupDrain().run(reference);
    return { type: "complete", disposition: result.kind === "superseded" ? "superseded" : "terminal" };
  };
  const bundleExpiry: WorkflowCommandHandler = async ({ reference }) => {
    const database = getPrismaClient();
    if (!database) throw Error("Bundle expiry requires a database scope");
    const result = await database.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx), record = await readExecutionDispatch(tx,reference.dispatchId);
      if (epoch !== reference.deploymentEpoch || !record || JSON.stringify(record.reference) !== JSON.stringify(reference) || reference.generation !== 1 || record.deadlineKind !== "operation" || !record.observedDeadlineAt) return { kind: "superseded" as const };
      const bundle = await tx.exportBundle.findUnique({ where: { id: reference.subject.id } });
      if (!bundle || await exportBundleExpiryInputHash(bundle) !== reference.inputHash) return { kind: "superseded" as const };
      return expireExportBundle(tx,bundle.id,record.observedDeadlineAt);
    });
    return result.kind === "sleep" ? { type: "sleep", until: result.dueAt.toISOString() } : { type: "complete", disposition: result.kind === "superseded" ? "superseded" : "terminal" };
  };
  const progress: WorkflowCommandHandler = async ({ reference }) => {
    const outcome = await getExecutionDispatch(createWorkerExecutionScheduler(bindings)).deliver(reference.dispatchId);
    if (outcome.status === "acknowledged") return { type: "complete" as const, disposition: "terminal" as const };
    if (outcome.status === "superseded" || outcome.status === "missing") return { type: "complete" as const, disposition: "superseded" as const };
    if (outcome.status === "pending") return { type: "sleep" as const, until: outcome.retryAt.toISOString() };
    throw new Error(`Progress continuation ${outcome.status}`);
  };
  return { maintenance: { maintenance, export_bundle: bundleExpiry }, project_progress: { maintenance: progress, workflow_event: progress },
    import_pipeline: { ingest_job: native }, render_run: { workflow_run: render, render_group: render },
    operation_driver: { native_validation: native, thumbnail_frame: native, outbound_probe: native, outbound_delivery: native, generated_media: native, clip_preparation: native, render_group: native, ingest_job: native,
      workflow_run: workflow, clip_selection_window: selectionWindow, workspace_billing: billing, library_index: library, generation_finishing: finishing, notification: emailNotification, media_cleanup: cleanup, social_publication: publication, completion_callback: notification, webhook_subscription: notification,
      upload_session: maintenancePage, autopilot_rule: autopilot, zoom_notification: zoomNotification,
      workspace_event: notificationEvents, maintenance: notificationEvents } };
}
