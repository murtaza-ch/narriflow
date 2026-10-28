import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { scopedKey, STALE_TIME, type WorkspaceScope } from "../core";
import type { LibraryClient } from "./index";

export type FoldersData = InferResponseType<LibraryClient["workspace"]["folders"]["$get"], 200>;

/** Library query keys: `library/folders` is the one folder list the explorer and the folder picker share. */
export const LIBRARY_RESOURCES = { folders: "folders", workspaceSearch: "workspace-search", search: "search", broll: "broll" } as const;

export type WorkspaceSearchData = InferResponseType<LibraryClient["workspace"]["search"]["$get"], 200>;
export type LibrarySearchData = InferResponseType<LibraryClient["library"]["search"]["$get"], 200>;
export type BrollSearchData = InferResponseType<LibraryClient["broll"]["search"]["$get"], 200>;

export interface LibrarySearchInput {
  q: string;
  limit?: number;
  projectId?: string;
}

export const libraryQueries = {
  /** Folders with their Project counts. */
  folders(client: LibraryClient, scope: WorkspaceScope) {
    return queryOptions({
      queryKey: scopedKey(scope, "library", LIBRARY_RESOURCES.folders),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }): Promise<FoldersData> =>
        (await client.workspace.folders.$get(undefined, { init: { signal } })).json() as Promise<FoldersData>,
    });
  },

  /** Title search over Projects, folders and clips (the command palette). */
  workspaceSearch(client: LibraryClient, scope: WorkspaceScope, q: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "library", LIBRARY_RESOURCES.workspaceSearch, { q }),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }): Promise<WorkspaceSearchData> =>
        (await client.workspace.search.$get({ query: { q } }, { init: { signal } })).json() as Promise<WorkspaceSearchData>,
    });
  },

  /** Semantic and exact-word search over transcripts. The server allows 30 searches a minute per person. */
  search(client: LibraryClient, scope: WorkspaceScope, input: LibrarySearchInput) {
    return queryOptions({
      queryKey: scopedKey(scope, "library", LIBRARY_RESOURCES.search, input),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }): Promise<LibrarySearchData> =>
        (
          await client.library.search.$get(
            {
              query: {
                q: input.q,
                ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
                ...(input.projectId ? { projectId: input.projectId } : {}),
              },
            },
            { init: { signal } },
          )
        ).json() as Promise<LibrarySearchData>,
    });
  },

  /** Stock B-roll search; `configured: false` when the Workspace has no Pexels key. */
  broll(client: LibraryClient, scope: WorkspaceScope, input: { query: string; orientation?: "portrait" | "landscape" | "square" }) {
    return queryOptions({
      queryKey: scopedKey(scope, "library", LIBRARY_RESOURCES.broll, input),
      staleTime: STALE_TIME.config,
      queryFn: async ({ signal }): Promise<BrollSearchData> =>
        (
          await client.broll.search.$get(
            { query: { query: input.query, ...(input.orientation ? { orientation: input.orientation } : {}) } },
            { init: { signal } },
          )
        ).json() as Promise<BrollSearchData>,
    });
  },
};
