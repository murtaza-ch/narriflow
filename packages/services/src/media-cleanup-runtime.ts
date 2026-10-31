import { getPrismaClient } from "@narriflow/db/client";
import { createMediaCleanupControl } from "./media-cleanup-control";
import { createMediaCleanupDrain } from "./media-cleanup-drain";
import { mediaCleanupObjectRetainUntil } from "./media-cleanup-holds";
import { createMediaCleanupStorage } from "./media-cleanup-storage";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { readServiceEnvironment } from "./runtime-environment";

function database() {
  const client = getPrismaClient();
  if (!client) throw Error("Media cleanup requires a database scope");
  return client;
}
export function getMediaCleanupControl() {
  const settings = readServiceEnvironment();
  return createMediaCleanupControl({ database: database(), register: deliverExecutionDispatches, hold: mediaCleanupObjectRetainUntil,
    storage: createMediaCleanupStorage({ accountId: settings.R2_ACCOUNT_ID ?? "", bucket: settings.R2_BUCKET ?? "",
      accessKeyId: settings.R2_ACCESS_KEY_ID ?? "", secretAccessKey: settings.R2_SECRET_ACCESS_KEY ?? "" }) });
}
export function getMediaCleanupDrain() {
  return createMediaCleanupDrain({ database: database(), register: deliverExecutionDispatches });
}
