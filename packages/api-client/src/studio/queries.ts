import { queryOptions } from "@tanstack/react-query";
import { type ApiTransport, scopedKey, type WorkspaceScope } from "../core";
import { createStudioClient } from "./client";

/** The clip a Studio read belongs to. */
export interface StudioClipTarget {
  projectId: string;
  clipId: string;
}

const POLL_STALE_MS = 0;

/**
 * `queryOptions` for the Studio's reads, keyed `studio/<resource>/<target>` and
 * passing the query's AbortSignal. The bootstrap seeds an Editing Session once:
 * it is never refetched in the background (a refetch would race the working
 * document) and is dropped on unmount, so focus/reconnect refetch is off. The
 * session owns the document, history and saves; nothing here observes them.
 */
export function studioQueries(transport: ApiTransport, scope: WorkspaceScope) {
  const key = (resource: string, target: StudioClipTarget) =>
    scopedKey(scope, "studio", resource, target) as unknown[];
  const client = () => createStudioClient(transport.scoped(scope));
  const param = (target: StudioClipTarget) => ({ param: { id: target.projectId, clipId: target.clipId } });
  /** Layout analyses are polled by bounded loops: always fresh, never retried, not kept. */
  const poll = { staleTime: POLL_STALE_MS, gcTime: 0, retry: false } as const;

  return {
    bootstrap: (target: StudioClipTarget) =>
      queryOptions({
        queryKey: key("bootstrap", target),
        queryFn: async ({ signal }) =>
          (await client().projects[":id"].clips[":clipId"].studio.$get(param(target), { init: { signal } })).json(),
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
      }),

    previewSource: (target: StudioClipTarget) =>
      queryOptions({
        queryKey: key("preview-source", target),
        queryFn: async ({ signal }) =>
          (await client().projects[":id"].clips[":clipId"]["preview-source"].$get(param(target), { init: { signal } })).json(),
        ...poll,
      }),

    autoLayout: (target: StudioClipTarget) =>
      queryOptions({
        queryKey: key("layout-auto", target),
        queryFn: async ({ signal }) =>
          (await client().projects[":id"].clips[":clipId"].layout.auto.$get(param(target), { init: { signal } })).json(),
        ...poll,
      }),

    splitLayout: (target: StudioClipTarget) =>
      queryOptions({
        queryKey: key("layout-split", target),
        queryFn: async ({ signal }) =>
          (await client().projects[":id"].clips[":clipId"].layout.split.$get(param(target), { init: { signal } })).json(),
        ...poll,
      }),

    screenLayout: (target: StudioClipTarget) =>
      queryOptions({
        queryKey: key("layout-screen", target),
        queryFn: async ({ signal }) =>
          (await client().projects[":id"].clips[":clipId"].layout.screen.$get(param(target), { init: { signal } })).json(),
        ...poll,
      }),
  };
}
