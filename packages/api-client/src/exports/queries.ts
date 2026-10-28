import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import type {
  ClipExportDetail,
  ExportDownloadGrant,
  WorkspaceExportPage,
  WorkspaceExportProjects,
  WorkspaceExportsQuery,
} from "@narriflow/validators/api/exports";
import { scopedKey, STALE_TIME, type WorkspaceScope } from "../core";
import type { ExportsClient } from "./index";

type Ok<Endpoint extends (...args: never[]) => Promise<unknown>> = InferResponseType<Endpoint, 200>;

type Init = { init: { signal: AbortSignal } };
const withSignal = (signal: AbortSignal): Init => ({ init: { signal } });

export type WorkspaceExportPageData = WorkspaceExportPage;
export type WorkspaceExportProjectsData = WorkspaceExportProjects;
export type ClipExportDetailData = ClipExportDetail;
export type ExportDownloadGrantData = ExportDownloadGrant;
export type CurrentProjectExportsData = Ok<ExportsClient["projects"][":id"]["exports"]["current"]["$get"]>;
export type ExportBundleListData = Ok<ExportsClient["projects"][":id"]["export-bundles"]["$get"]>;
export type ExportBundleData = Ok<ExportsClient["projects"][":id"]["export-bundles"][":bundleId"]["$get"]>;
export type TimelineSourceGrant = Ok<ExportsClient["projects"][":id"]["clips"][":clipId"]["timeline-source"]["$get"]>;

/** Query-key resources of the exports domain. */
export const EXPORT_RESOURCES = {
  workspaceList: "workspace-list",
  workspaceProjects: "workspace-projects",
  detail: "detail",
  current: "current",
  bundles: "bundles",
  bundle: "bundle",
} as const;

/** Exports Download Grants are never queries: they expire in minutes (a bundle's in one), so they are fetched on the click that uses them. */
export const exportQueries = {
  /** The Exports page: the Workspace's exports under its filters and cursor. */
  workspaceList(client: ExportsClient, scope: WorkspaceScope, filters: WorkspaceExportsQuery = {}) {
    return queryOptions({
      queryKey: scopedKey(scope, "exports", EXPORT_RESOURCES.workspaceList, filters),
      // Cards carry short-lived playback URLs and rendering progress.
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }): Promise<WorkspaceExportPage> =>
        (await client.workspace.exports.$get({ query: filters }, withSignal(signal))).json(),
    });
  },

  /** Projects that have exports, for the Exports filter. */
  workspaceProjects(client: ExportsClient, scope: WorkspaceScope) {
    return queryOptions({
      queryKey: scopedKey(scope, "exports", EXPORT_RESOURCES.workspaceProjects),
      staleTime: STALE_TIME.config,
      queryFn: async ({ signal }): Promise<WorkspaceExportProjects> =>
        (await client.workspace["export-projects"].$get({}, withSignal(signal))).json(),
    });
  },

  /** One export with its Project's workflow cursor (`lastSeq`). A missing export is a 404 `export_not_found`. */
  detail(client: ExportsClient, scope: WorkspaceScope, projectId: string, clipId: string, exportId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "exports", EXPORT_RESOURCES.detail, { id: projectId, clipId, exportId }),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }): Promise<ClipExportDetail> => {
        const response = await client.projects[":id"].clips[":clipId"].exports[":exportId"].$get(
          { param: { id: projectId, clipId, exportId } },
          withSignal(signal),
        );
        // The transport throws `ApiError` for the 404; only the 200 body reaches here.
        return (await response.json()) as ClipExportDetail;
      },
    });
  },

  /** The Project's current ready exports (those cut from the clip's present revision). */
  current(client: ExportsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "exports", EXPORT_RESOURCES.current, projectId),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }): Promise<CurrentProjectExportsData> =>
        (await client.projects[":id"].exports.current.$get({ param: { id: projectId } }, withSignal(signal))).json(),
    });
  },

  bundles(client: ExportsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "exports", EXPORT_RESOURCES.bundles, projectId),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }): Promise<ExportBundleListData> =>
        (await client.projects[":id"]["export-bundles"].$get({ param: { id: projectId } }, withSignal(signal))).json(),
    });
  },

  bundle(client: ExportsClient, scope: WorkspaceScope, projectId: string, bundleId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "exports", EXPORT_RESOURCES.bundle, { id: projectId, bundleId }),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }): Promise<ExportBundleData> =>
        (
          await client.projects[":id"]["export-bundles"][":bundleId"].$get(
            { param: { id: projectId, bundleId } },
            withSignal(signal),
          )
        ).json(),
    });
  },
};
