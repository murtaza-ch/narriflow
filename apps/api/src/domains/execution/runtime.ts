import { executionKeyRing } from "../../execution-keys";
import type { ExecutionRouteDependencies } from "./routes";
import { ExecutorControlError } from "@narriflow/services/executor-control";
import { getPrismaClient } from "@narriflow/db/client";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { createExecutionStorage } from "@narriflow/services/execution-storage";
import { createNativeValidationExecution } from "@narriflow/services/native-validation-execution";
import { getNativeValidationService } from "@narriflow/services/native-validation-runtime";
import { getThumbnailFrameExecution } from "@narriflow/services/thumbnail-frame-preparation-runtime";
import { deliverExecutionDispatches } from "@narriflow/services/execution-dispatch-runtime";
import { getOutboundProbeService } from "@narriflow/services/outbound-probe-runtime";
import { createOutboundProbeExecution } from "@narriflow/services/outbound-probe-execution";
import { createIngestSourceExecution } from "@narriflow/services/ingest-source-execution";
import { createOutboundDeliveryExecution } from "@narriflow/services/outbound-delivery-execution";
import { getOutboundDeliveryService } from "@narriflow/services/outbound-delivery-runtime";
import { getGeneratedMediaExecution } from "@narriflow/services/generated-media-runtime";
import { getClipPreparationService } from "@narriflow/services/clip-preparation-runtime";
import { createClipPreparationExecution } from "@narriflow/services/clip-preparation-execution";
import { createRenderGroupExecution } from "@narriflow/services/render-group-execution";
import { getRenderGroupExecutionService } from "@narriflow/services/render-group-runtime";
import { getExportBundleExecution } from "@narriflow/services/export-bundle-runtime";
import { createExportBundleExecution } from "@narriflow/services/export-bundle-execution";
import { getDubbingExecution } from "@narriflow/services/dubbing-execution-runtime";
import { createDubbingExecution } from "@narriflow/services/dubbing-execution";
import { createPublicationExecutionControl } from "@narriflow/services/publication-execution-control";
import { getPublicationExecution } from "@narriflow/services/publication-execution-runtime";
import { createGeneratedMediaExecution } from "@narriflow/services/generated-media-control";
import { getIngestJobLifecycle } from "@narriflow/services/ingest-job-lifecycle-runtime";
import { getWorkflowRunLifecycle } from "@narriflow/services/workflow-run-lifecycle";
import { createDriveTokenCipher } from "@narriflow/services/drive-source";
import { zoomService } from "@narriflow/services/zoom.service";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ApiWorkerBindings } from "../../worker-bindings";
import { createAssignedArtifactStorage } from "./artifact-storage";

/** Parse the executor-to-Worker ring at the verification boundary, never at module import. */
export function executorControlKeyRing(environment: Readonly<Record<string, string | undefined>>): ReadonlyMap<string, Uint8Array> {
  return executionKeyRing(environment.EXECUTOR_CONTROL_KEYS_JSON);
}

export function createExecutionDependencies(environment: Readonly<Record<string, string | undefined>>, execute: ExecutionRouteDependencies["execute"], transfer: ExecutionRouteDependencies["transfer"]): ExecutionRouteDependencies {
  return { keyRing: () => executorControlKeyRing(environment), nowSeconds: () => Math.floor(Date.now() / 1000), execute, transfer };
}

/** Called only after raw-byte signature verification, inside the request or
 * command step's fresh database scope. No clients survive this invocation. */
export async function createWorkerExecutor(reference: ExecutionDispatchReference, bindings?: ApiWorkerBindings) {
  if (!bindings?.MEDIA_BUCKET) throw new ExecutorControlError("storage_unavailable");
  if (!["native_validation", "thumbnail_frame", "outbound_probe", "outbound_delivery", "generated_media", "clip_preparation", "render_group", "social_publication", "ingest_job", "workflow_run"].includes(reference.subject.kind)) throw new ExecutorControlError("scheduler_unavailable");
  const database = getPrismaClient();
  if (!database) throw new ExecutorControlError("epoch_unavailable");
  const environment = readServiceEnvironment();
  const required = (name: string) => { const value = environment[name]; if (!value) throw new ExecutorControlError("storage_unavailable"); return value; };
  const storage = createExecutionStorage({ accountId: required("R2_ACCOUNT_ID"), bucket: required("R2_BUCKET"),
    accessKeyId: required("R2_ACCESS_KEY_ID"), secretAccessKey: required("R2_SECRET_ACCESS_KEY") });
  const common = { database, storage, artifacts: createAssignedArtifactStorage(bindings.MEDIA_BUCKET), deliverWakes: deliverExecutionDispatches };
  if (reference.subject.kind === "workflow_run") {
    const execution = await getWorkerWorkflowRunService(reference, bindings.MEDIA_BUCKET);
    return execution.stage === "dubbing" ? createDubbingExecution({ ...common, domain: execution.domain }) : createExportBundleExecution({ ...common, domain: execution.domain });
  }
  if (reference.subject.kind === "social_publication") return createPublicationExecutionControl({ ...common, environment,
    domain: getPublicationExecution() });
  if (reference.subject.kind === "render_group") return createRenderGroupExecution({ ...common,
    service: await getWorkerRenderGroupService(bindings.MEDIA_BUCKET) });
  if (reference.subject.kind === "clip_preparation") return createClipPreparationExecution({ ...common, domain: await getClipPreparationService() });
  if (reference.subject.kind === "ingest_job") return createIngestSourceExecution({ ...common, domain: getIngestJobLifecycle(), workflow: getWorkflowRunLifecycle(), toolchainFingerprint: required(reference.kind === "local_fetch" ? "MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT" : "MEDIA_FETCH_TOOLCHAIN_FINGERPRINT"),
    sourceReads: { openDriveCredential: sealed => createDriveTokenCipher().open(sealed), zoomRecordingDownload: input => zoomService.recordingDownload(input) } });
  if (reference.subject.kind === "outbound_delivery") return createOutboundDeliveryExecution({ ...common, domain: getOutboundDeliveryService() });
  if (reference.subject.kind === "generated_media") return createGeneratedMediaExecution({ ...common, domain: getGeneratedMediaExecution() });
  if (reference.subject.kind === "outbound_probe") return createOutboundProbeExecution({ ...common, domain: getOutboundProbeService() });
  const domain = reference.subject.kind === "thumbnail_frame" ? { subjectKind: "thumbnail_frame" as const, domain: getThumbnailFrameExecution() }
    : { subjectKind: "native_validation" as const, domain: getNativeValidationService() };
  return createNativeValidationExecution({ ...domain, ...common });
}

export function getWorkerRenderGroupService(bucket: R2Bucket) {
  return getRenderGroupExecutionService(workerArtifactHead(bucket));
}

export function getWorkerExportBundleService(bucket: R2Bucket) {
  return getExportBundleExecution(workerArtifactHead(bucket));
}

/** Route by the current accepted row. A caller cannot select a paid stage or
 * swap a Bundle reference into a Dub factory. Each Core then locks its exact
 * generation, epoch, input and native owner before any mutation or grant. */
export async function getWorkerWorkflowRunService(reference: ExecutionDispatchReference, bucket: R2Bucket) {
  if (reference.subject.kind !== "workflow_run") throw new ExecutorControlError("invalid_reference");
  const database = getPrismaClient();if (!database) throw new ExecutorControlError("epoch_unavailable");
  const row = await database.workflowRun.findUnique({ where: { id: reference.subject.id }, select: { stage: true } });
  if (row?.stage === "dubbing") return { stage: "dubbing" as const, domain: getDubbingExecution(workerArtifactHead(bucket)) };
  if (row?.stage === "export_bundle") return { stage: "export_bundle" as const, domain: getWorkerExportBundleService(bucket) };
  throw new ExecutorControlError("invalid_reference");
}

function workerArtifactHead(bucket: R2Bucket) {
  return async (storageKey: string) => {
    const object = await bucket.head(storageKey);
    if (!object) return null;
    if (object.key !== storageKey) throw new ExecutorControlError("artifact_invalid");
    return { storageKey, etag: object.httpEtag, byteLength: object.size,
      ...(object.checksums.sha256 ? { sha256: Array.from(new Uint8Array(object.checksums.sha256), byte => byte.toString(16).padStart(2, "0")).join("") } : {}) };
  };
}

export function createWorkerExecutionDependencies(): ExecutionRouteDependencies {
  return { keyRing: () => executorControlKeyRing(readServiceEnvironment()), nowSeconds: () => Math.floor(Date.now() / 1000),
    execute: async (command, verifiedRequest, bindings) => (await createWorkerExecutor(command.action === "acquire" ? command.reference : command.fence.reference, bindings)).control.execute({ command, verifiedRequest }),
    transfer: async (command, verifiedRequest, bindings) => (await createWorkerExecutor(command.fence.reference, bindings)).transfer.execute({ command, verifiedRequest }),
  };
}
