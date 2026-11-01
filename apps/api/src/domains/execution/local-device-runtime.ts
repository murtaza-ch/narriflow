import { getPrismaClient } from "@narriflow/db/client";
import type { ActorScope } from "@narriflow/services/actor-scope";
import { createLocalFetchDeviceCodec, LocalFetchDeviceError, requireLocalFetchDevelopment } from "@narriflow/services/local-fetch-device";
import { createLocalFetchDeviceExecution } from "@narriflow/services/local-fetch-device-execution";
import { readExecutionDispatch } from "@narriflow/services/execution-dispatch";
import { getExecutionDispatch } from "@narriflow/services/execution-dispatch-runtime";
import { ExecutorControlError } from "@narriflow/services/executor-control";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { workspaceService } from "@narriflow/services/workspace.service";
import { executionKeyRing } from "../../execution-keys";
import type { ApiWorkerBindings } from "../../worker-bindings";
import { deliverLocalFetchReference } from "../../workflows/scheduler";
import { localDeviceMailbox } from "../../resource-ports";

function codec() { return createLocalFetchDeviceCodec(executionKeyRing(readServiceEnvironment().DEV_DEVICE_KEYS_JSON)); }
/** First-party authenticated issuance. The returned key is scoped to this
 * development Workspace, actor, epoch and two-hour session. */
export async function issueLocalFetchDevice(actor: ActorScope, bindings: ApiWorkerBindings) {
  const environment = readServiceEnvironment();
  requireLocalFetchDevelopment(environment, actor.workspaceId);
  await workspaceService.requireActor(actor.actorUserId, actor.workspaceId, "processing.consume");
  const database = getPrismaClient();
  if (!database || !environment.DEV_DEVICE_KEY_ID || !environment.API_ORIGIN || !(bindings.LOCAL_FETCH_MAILBOX || bindings.DEV_CLOUD) || !/^[a-f0-9]{64}$/.test(environment.MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT ?? "")) throw new LocalFetchDeviceError("local_fetch_unavailable");
  const epoch = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
  const issued = await codec().issue({ actorUserId: actor.actorUserId, workspaceId: actor.workspaceId,
    deploymentEpoch: epoch.epoch, apiOrigin: environment.API_ORIGIN }, environment.DEV_DEVICE_KEY_ID);
  await localDeviceMailbox(bindings, actor.workspaceId).register(issued.claims);
  return { version: 1 as const, apiOrigin: environment.API_ORIGIN, sessionToken: issued.token, keyId: issued.claims.sessionId,
    key: Buffer.from(issued.key).toString("base64url"), workspaceId: actor.workspaceId, expiresAt: issued.claims.expiresAt, toolchainFingerprint: environment.MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT! };
}


/** Wiring stays lazy so invalid device signatures cannot resolve a client. */
export function getLocalFetchDeviceExecution(bindings: ApiWorkerBindings) {
  const database = () => {
    const value = getPrismaClient();
    if (!value) throw new ExecutorControlError("epoch_unavailable");
    return value;
  };
  return createLocalFetchDeviceExecution({
    database,
    requireActor: scope => workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "processing.consume"),
    delivery: {
      read: id => readExecutionDispatch(database(), id),
      replay: reference => deliverLocalFetchReference(reference, bindings),
      deliver: id => getExecutionDispatch().deliver(id),
    },
  });
}
