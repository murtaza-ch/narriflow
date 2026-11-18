import { getPrismaClient } from "@narriflow/db/client";
import { DubbingExecution } from "./dubbing-execution";
import { getPrivateJsonStorage } from "./clip-preparation-runtime";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { readServiceEnvironment } from "./runtime-environment";

/** Fresh command-scoped clients and explicit runtime identity. */
export function getDubbingExecution() {
  const database = getPrismaClient();if (!database) throw Error("Dubbing execution requires a database scope");
  return new DubbingExecution(database, { toolchainFingerprint: readServiceEnvironment().MEDIA_FETCH_TOOLCHAIN_FINGERPRINT ?? "",
    inputStorage: getPrivateJsonStorage(), register: deliverExecutionDispatches });
}
