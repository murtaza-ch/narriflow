import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import type { ClipDownloadQuery } from "@narriflow/validators/api/clips";
import { scopedKey, STALE_TIME, type WorkspaceScope } from "../core";
import type { ClipsClient } from "./index";

type Ok<Endpoint extends (...args: never[]) => Promise<unknown>> = InferResponseType<Endpoint, 200>;

type Init = { init: { signal: AbortSignal } };
const withSignal = (signal: AbortSignal): Init => ({ init: { signal } });

export type ClipListData = Ok<ClipsClient["projects"][":id"]["clips"]["$get"]>;
export type ClipPreviewsData = Ok<ClipsClient["projects"][":id"]["clips"]["previews"]["$get"]>;
export type ClipDownloadGrant = Ok<ClipsClient["projects"][":id"]["clips"][":clipId"]["download"]["$get"]>;
export type CampaignOperationsData = Ok<ClipsClient["projects"][":id"]["campaign-operations"]["$get"]>;
export type EditorActionCatalogData = Ok<
  ClipsClient["projects"][":id"]["campaign-operations"]["editor-action-catalog"]["$get"]
>;
export type ThumbnailFrameData = Ok<ClipsClient["projects"][":id"]["thumbnail-frames"][":operationId"]["$get"]>;

/** Query-key resources of the clips domain. */
export const CLIP_RESOURCES = {
  list: "list",
  previews: "previews",
  peaks: "peaks",
  download: "download",
  campaignOperations: "campaign-operations",
  editorActionCatalog: "editor-action-catalog",
  thumbnailFrame: "thumbnail-frame",
} as const;

/**
 * Query factories of the clips domain. Each takes the typed client and the
 * captured Workspace scope; pages never build URLs. Every function passes the
 * abort signal through.
 */
export const clipQueries = {
  /** A Project's clips, newest run first. */
  list(client: ClipsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "clips", CLIP_RESOURCES.list, projectId),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }): Promise<ClipListData> =>
        (await client.projects[":id"].clips.$get({ param: { id: projectId } }, withSignal(signal))).json(),
    });
  },

  /**
   * Short-lived playback grants for the Project's clip previews. They expire:
   * refetch after the tab resumes, never persist them.
   */
  previews(client: ClipsClient, scope: WorkspaceScope, projectId: string, query: ClipDownloadQuery = {}) {
    return queryOptions({
      queryKey: scopedKey(scope, "clips", CLIP_RESOURCES.previews, { id: projectId, ...query }),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }): Promise<ClipPreviewsData> =>
        (
          await client.projects[":id"].clips.previews.$get({ param: { id: projectId }, query }, withSignal(signal))
        ).json(),
    });
  },

  /** A short-lived download grant; navigate to `downloadUrl` without Clerk credentials. */
  downloadGrant(
    client: ClipsClient,
    scope: WorkspaceScope,
    projectId: string,
    clipId: string,
    query: ClipDownloadQuery = {},
  ) {
    return queryOptions({
      queryKey: scopedKey(scope, "clips", CLIP_RESOURCES.download, { id: projectId, clipId, ...query }),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }): Promise<ClipDownloadGrant> =>
        (
          await client.projects[":id"].clips[":clipId"].download.$get(
            { param: { id: projectId, clipId }, query },
            withSignal(signal),
          )
        ).json(),
    });
  },

  /** Waveform peaks, or `null` when the preview has none (204). */
  peaks(client: ClipsClient, scope: WorkspaceScope, projectId: string, clipId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "clips", CLIP_RESOURCES.peaks, { id: projectId, clipId }),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }) => {
        const response = await client.projects[":id"].clips[":clipId"]["preview-peaks"].$get(
          { param: { id: projectId, clipId } },
          withSignal(signal),
        );
        return response.status === 204 ? null : response.json();
      },
    });
  },

  /** Campaign operations of a Project, newest first. Poll while one is running. */
  campaignOperations(client: ClipsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "clips", CLIP_RESOURCES.campaignOperations, projectId),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }): Promise<CampaignOperationsData> =>
        (
          await client.projects[":id"]["campaign-operations"].$get({ param: { id: projectId } }, withSignal(signal))
        ).json(),
    });
  },

  editorActionCatalog(client: ClipsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "clips", CLIP_RESOURCES.editorActionCatalog, projectId),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }): Promise<EditorActionCatalogData> =>
        (
          await client.projects[":id"]["campaign-operations"]["editor-action-catalog"].$get(
            { param: { id: projectId } },
            withSignal(signal),
          )
        ).json(),
    });
  },

  /** One thumbnail frame operation; poll while it is queued or processing. */
  thumbnailFrame(client: ClipsClient, scope: WorkspaceScope, projectId: string, operationId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "clips", CLIP_RESOURCES.thumbnailFrame, { id: projectId, operationId }),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }): Promise<ThumbnailFrameData> =>
        (
          await client.projects[":id"]["thumbnail-frames"][":operationId"].$get(
            { param: { id: projectId, operationId } },
            withSignal(signal),
          )
        ).json(),
    });
  },
};
