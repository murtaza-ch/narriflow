import { getPrismaClient } from "@narriflow/db/client";
import { ClipPreparationService } from "./clip-preparation";
import { clipPreparationEngineHash } from "./clip-preparation-policy";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { createPrivateJsonStorage } from "./private-json-storage";
import { readServiceEnvironment } from "./runtime-environment";

/** A fresh Workers-safe client for this invocation's private capsule I/O. */
export function getPrivateJsonStorage() {
  const settings = readServiceEnvironment();
  return createPrivateJsonStorage({ accountId: settings.R2_ACCOUNT_ID ?? "", bucket: settings.R2_BUCKET ?? "",
    accessKeyId: settings.R2_ACCESS_KEY_ID ?? "", secretAccessKey: settings.R2_SECRET_ACCESS_KEY ?? "" });
}

/** Neither this service nor its database/storage clients may cross a sleep. */
export async function getClipPreparationService() {
  const database = getPrismaClient();
  if (!database) throw new Error("Clip preparation requires a database scope");
  const toolchainFingerprint = readServiceEnvironment().MEDIA_RENDER_TOOLCHAIN_FINGERPRINT;
  if (!toolchainFingerprint || !/^[a-f0-9]{64}$/.test(toolchainFingerprint)) throw new Error("clip_preparation_configuration_invalid");
  return new ClipPreparationService(database, { toolchainFingerprint, engineHash: await clipPreparationEngineHash(toolchainFingerprint),
    storage: getPrivateJsonStorage(), register: deliverExecutionDispatches });
}
