import type { ExportsRoutes } from "@narriflow/api/types/exports";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { ExportsRoutes };

/** Typed client for the exports routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createExportsClient(transport: RpcTransport) {
  return createRpcClient<ExportsRoutes>(transport);
}

export type ExportsClient = ReturnType<typeof createExportsClient>;

export {
  EXPORT_ATTACHMENT_MAX_BYTES,
  fetchSubtitleFile,
  fetchTimelineArchive,
  type ExportAttachment,
  type TimelineArchive,
} from "./attachments";
export {
  exportCommands,
  exportMutationOptions,
  invalidateAfterExportChange,
  invalidateWorkspaceExports,
} from "./mutations";
export {
  EXPORT_RESOURCES,
  exportQueries,
  type ClipExportDetailData,
  type CurrentProjectExportsData,
  type ExportBundleData,
  type ExportBundleListData,
  type ExportDownloadGrantData,
  type TimelineSourceGrant,
  type WorkspaceExportPageData,
  type WorkspaceExportProjectsData,
} from "./queries";
