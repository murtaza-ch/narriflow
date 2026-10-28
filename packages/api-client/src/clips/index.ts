import type { ClipsRoutes } from "@narriflow/api/types/clips";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { ClipsRoutes };

/** Typed client for the clips routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createClipsClient(transport: RpcTransport) {
  return createRpcClient<ClipsRoutes>(transport);
}

export type ClipsClient = ReturnType<typeof createClipsClient>;

export {
  clipCommands,
  clipMutationOptions,
  invalidateAfterClipChange,
  invalidateAfterThumbnailFrame,
  invalidateProjectClips,
} from "./mutations";
export {
  CLIP_RESOURCES,
  clipQueries,
  type CampaignOperationsData,
  type ClipDownloadGrant,
  type ClipListData,
  type ClipPreviewsData,
  type EditorActionCatalogData,
  type ThumbnailFrameData,
} from "./queries";
