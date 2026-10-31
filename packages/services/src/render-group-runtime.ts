import { getPrismaClient } from "@narriflow/db/client";
import { getClipPreparationService, getPrivateJsonStorage } from "./clip-preparation-runtime";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { isPexelsConfigured, searchPexelsVideos } from "./pexels.service";
import { RenderGroupExecutionService } from "./render-group-execution";
import { createRenderInputSnapshot, type RenderInputSnapshotDependencies } from "./render-input-snapshot";
import { readServiceEnvironment } from "./runtime-environment";

/** Resolve fresh scope-bound ports. Neither the database nor a capsule crosses a wait. */
export async function getRenderGroupExecutionService(object: RenderInputSnapshotDependencies["object"]) {
  const database = getPrismaClient();
  if (!database) throw new Error("Render execution requires a database scope");
  const toolchainFingerprint = readServiceEnvironment().MEDIA_RENDER_TOOLCHAIN_FINGERPRINT;
  if (!toolchainFingerprint || !/^[a-f0-9]{64}$/.test(toolchainFingerprint)) throw new Error("render_configuration_invalid");
  return new RenderGroupExecutionService(database, { toolchainFingerprint,
    preparation: await getClipPreparationService(), inputStorage: getPrivateJsonStorage(), register: deliverExecutionDispatches,
    snapshot: createRenderInputSnapshot(database, { object, pexelsConfigured: isPexelsConfigured(), searchStock: searchPexelsVideos }),
  });
}
