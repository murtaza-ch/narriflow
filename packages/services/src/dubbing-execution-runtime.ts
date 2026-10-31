import { getPrismaClient } from "@narriflow/db/client";
import { DubbingExecution } from "./dubbing-execution";
import { getPrivateJsonStorage } from "./clip-preparation-runtime";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { readServiceEnvironment } from "./runtime-environment";
import type { DubbingExecutionInput } from "@narriflow/validators/dubbing-execution";

/** Fresh command-scoped clients and explicit runtime identity. */
export function getDubbingExecution(head: (storageKey: string) => Promise<DubbingExecutionInput["baseVideo"] | null>) {
  const database = getPrismaClient();if (!database) throw Error("Dubbing execution requires a database scope");
  return new DubbingExecution(database, { toolchainFingerprint: readServiceEnvironment().MEDIA_FETCH_TOOLCHAIN_FINGERPRINT ?? "",
    inputStorage: getPrivateJsonStorage(), register: deliverExecutionDispatches,
    head: async storageKey => {
      const object = await head(storageKey);if (!object || object.storageKey !== storageKey) return null;
      if (object.sha256) return object;
      const committed = await database.executionArtifact.findFirst({ where: { storageKey, etag: object.etag, byteLength: BigInt(object.byteLength), committedAt: { not: null } }, select: { checksumSha256: true } });
      return committed?.checksumSha256 ? { ...object, sha256: committed.checksumSha256 } : object;
    } });
}
