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
import { getIngestJobLifecycle } from "@narriflow/services/ingest-job-lifecycle-runtime";
import { getWorkflowRunLifecycle } from "@narriflow/services/workflow-run-lifecycle";
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
export function createWorkerExecutor(reference: ExecutionDispatchReference, bindings?: ApiWorkerBindings) {
  if (!bindings?.MEDIA_BUCKET) throw new ExecutorControlError("storage_unavailable");
  if (!["native_validation", "thumbnail_frame", "outbound_probe", "outbound_delivery", "ingest_job"].includes(reference.subject.kind)) throw new ExecutorControlError("scheduler_unavailable");
  const database = getPrismaClient();
  if (!database) throw new ExecutorControlError("epoch_unavailable");
  const environment = readServiceEnvironment();
  const required = (name: string) => { const value = environment[name]; if (!value) throw new ExecutorControlError("storage_unavailable"); return value; };
  const storage = createExecutionStorage({ accountId: required("R2_ACCOUNT_ID"), bucket: required("R2_BUCKET"),
    accessKeyId: required("R2_ACCESS_KEY_ID"), secretAccessKey: required("R2_SECRET_ACCESS_KEY") });
  const common = { database, storage, artifacts: createAssignedArtifactStorage(bindings.MEDIA_BUCKET), deliverWakes: deliverExecutionDispatches };
  if (reference.subject.kind === "ingest_job") return createIngestSourceExecution({ ...common, domain: getIngestJobLifecycle(), workflow: getWorkflowRunLifecycle(), toolchainFingerprint: required(reference.kind === "local_fetch" ? "MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT" : "MEDIA_FETCH_TOOLCHAIN_FINGERPRINT") });
  if (reference.subject.kind === "outbound_delivery") return createOutboundDeliveryExecution({ ...common, domain: getOutboundDeliveryService() });
  if (reference.subject.kind === "outbound_probe") return createOutboundProbeExecution({ ...common, domain: getOutboundProbeService() });
  const domain = reference.subject.kind === "thumbnail_frame" ? { subjectKind: "thumbnail_frame" as const, domain: getThumbnailFrameExecution() }
    : { subjectKind: "native_validation" as const, domain: getNativeValidationService() };
  return createNativeValidationExecution({ ...domain, ...common });
}

export function createWorkerExecutionDependencies(): ExecutionRouteDependencies {
  return { keyRing: () => executorControlKeyRing(readServiceEnvironment()), nowSeconds: () => Math.floor(Date.now() / 1000),
    execute: (command, verifiedRequest, bindings) => createWorkerExecutor(command.action === "acquire" ? command.reference : command.fence.reference, bindings).control.execute({ command, verifiedRequest }),
    transfer: (command, verifiedRequest, bindings) => createWorkerExecutor(command.fence.reference, bindings).transfer.execute({ command, verifiedRequest }),
  };
}
