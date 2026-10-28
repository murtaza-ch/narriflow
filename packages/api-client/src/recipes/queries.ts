import { queryOptions } from "@tanstack/react-query";
import { type ApiTransport, scopedKey, STALE_TIME, type WorkspaceScope } from "../core";
import { createRecipesClient } from "./client";

export const recipesKeys = {
  list: (scope: WorkspaceScope) => scopedKey(scope, "recipes", "list"),
};

/** The Workspace's saved Recipes. */
export function recipesListQueryOptions(input: { transport: ApiTransport; scope: WorkspaceScope }) {
  return queryOptions({
    queryKey: recipesKeys.list(input.scope),
    queryFn: async ({ signal }) => {
      const client = createRecipesClient(input.transport.scoped(input.scope));
      const response = await client.recipes.$get(undefined, { init: { signal } });
      return (await response.json()).recipes;
    },
    staleTime: STALE_TIME.config,
  });
}
