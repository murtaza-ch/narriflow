"use client";

import {
  describeApiFailure,
  invalidateScoped,
  isApiError,
  type ApiRuntime,
  type WorkspaceScope,
} from "@narriflow/api-client";
import { createClipsClient } from "@narriflow/api-client/clips";
import { createLibraryClient, invalidateAfterFolderChange } from "@narriflow/api-client/library";
import {
  createProjectsClient,
  PROJECT_RESOURCES,
  projectQueries,
  type ProjectListFilters,
  type ProjectListPage,
} from "@narriflow/api-client/projects";
import { hasUserErrorMessage, userErrorMessage } from "@narriflow/validators";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";

/** A Project as the list endpoints send it (dates are ISO strings). */
export type ProjectListItem = ProjectListPage["items"][number];

/** The typed clients of the Projects and library domains, bound to one captured user and Workspace. */
export interface LibraryApi {
  runtime: ApiRuntime;
  scope: WorkspaceScope;
  projects: ReturnType<typeof createProjectsClient>;
  library: ReturnType<typeof createLibraryClient>;
  clips: ReturnType<typeof createClipsClient>;
}

/** The clients for the selected Workspace, or null until a Workspace is selected. */
export function useLibraryApi(): LibraryApi | null {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  return useMemo(() => {
    if (!scope) return null;
    const transport = runtime.transport.scoped(scope);
    return {
      runtime,
      scope,
      projects: createProjectsClient(transport),
      library: createLibraryClient(transport),
      clips: createClipsClient(transport),
    };
  }, [runtime, scope]);
}

/** Warms the explorer for a link the person is about to follow (hover or keyboard focus). */
export function usePrefetchExplorer(): (filters?: ProjectListFilters) => void {
  const api = useLibraryApi();
  const queryClient = useQueryClient();
  return useCallback(
    (filters) => {
      if (api) void queryClient.prefetchQuery(projectQueries.explorer(api.projects, api.scope, filters));
    },
    [api, queryClient],
  );
}

/**
 * After a folder was created, renamed or deleted: the folder list and every
 * Project list that shows folders or counts, including the home's recent Projects.
 */
export function invalidateAfterFolderChanged(queryClient: QueryClient, scope: WorkspaceScope) {
  return Promise.all([
    invalidateAfterFolderChange(queryClient, scope),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.home),
  ]);
}

/** Display text for a failed call: the API's own message for a refused request, else `fallback`. */
export function failureMessage(error: unknown, fallback: string): string {
  if (describeApiFailure(error).kind === "offline") {
    return "You appear to be offline. Check your connection and try again.";
  }
  if (isApiError(error) && error.status >= 400 && error.status < 500) {
    return hasUserErrorMessage(error.code) ? (userErrorMessage(error.code) ?? fallback) : error.message || fallback;
  }
  return fallback;
}
