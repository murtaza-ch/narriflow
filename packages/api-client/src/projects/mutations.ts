import type { QueryClient } from "@tanstack/query-core";
import type { GenerateProjectInput } from "@narriflow/validators";
import type {
  ApplyProjectBrandProfileRequest,
  NotifyPreferenceRequest,
} from "@narriflow/validators/api/projects";
import { IDEMPOTENCY_KEY_HEADER, invalidateScoped, scopedKey, type WorkspaceScope } from "../core";
import { invalidateWorkspaceUsage } from "../workspace/queries";
import type { ProjectsClient } from "./index";
import { PROJECT_RESOURCES } from "./queries";

const withKey = (idempotencyKey: string) => ({ headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } });

/**
 * Project commands. Retryable acceptance (`generate`) takes the intent's
 * Idempotency-Key (`runtime.createIntent()`); the others are naturally
 * idempotent replacements or deletions and carry none. Plan and credit refusals
 * arrive as an `ApiError` whose `code` and `details` the UI renders in place of
 * the old redirect to the Project page.
 */
export const projectCommands = {
  generate(client: ProjectsClient, projectId: string, input: GenerateProjectInput, idempotencyKey: string) {
    return client.projects[":id"].generate
      .$post({ param: { id: projectId }, json: input }, withKey(idempotencyKey))
      .then((response) => response.json());
  },

  applyBrandProfile(client: ProjectsClient, projectId: string, input: ApplyProjectBrandProfileRequest) {
    return client.projects[":id"]["brand-profile"]
      .$post({ param: { id: projectId }, json: input })
      .then((response) => response.json());
  },

  setNotifyPreference(client: ProjectsClient, projectId: string, input: NotifyPreferenceRequest) {
    return client.projects[":id"]["notify-preference"]
      .$put({ param: { id: projectId }, json: input })
      .then((response) => response.json());
  },

  /** Moves a Project into a folder, or out of its folder with `null`. */
  moveToFolder(client: ProjectsClient, projectId: string, folderId: string | null) {
    return client.projects[":id"].folder
      .$patch({ param: { id: projectId }, json: { folderId } })
      .then((response) => response.json());
  },

  /** Permanent. Treat a 404 `project_not_found` as success: the Project is already gone. */
  remove(client: ProjectsClient, projectId: string) {
    return client.projects[":id"].$delete({ param: { id: projectId } }).then((response) => response.json());
  },
};

/** Mutations never retry on their own; spread into `useMutation` options. */
export const projectMutationOptions = { retry: false } as const;

/** Home, explorer and list reads: every place a Project and its counts are listed. */
export async function invalidateProjectCollections(queryClient: QueryClient, scope: WorkspaceScope) {
  await Promise.all([
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.home),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.explorer),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.list),
  ]);
}

/** Refreshes every opened tab of one Project's screen and its standalone reads. */
export async function invalidateProject(queryClient: QueryClient, scope: WorkspaceScope, projectId: string) {
  await Promise.all([
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.detail, projectId),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.snapshot, projectId),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.contentPack, projectId),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.creditUsage, projectId),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.finishing, projectId),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.workflowHistory, projectId),
  ]);
}

/**
 * After the API accepted a generation: the Project, the lists that show its
 * progress, and Workspace usage. Call on confirmed acceptance only.
 */
export async function invalidateAfterGeneration(queryClient: QueryClient, scope: WorkspaceScope, projectId: string) {
  await Promise.all([
    invalidateProject(queryClient, scope, projectId),
    invalidateProjectCollections(queryClient, scope),
    invalidateWorkspaceUsage(queryClient, scope),
  ]);
}

/** After a Brand Profile was applied: the Project's brand shows in its snapshot. */
export function invalidateAfterBrandApplied(queryClient: QueryClient, scope: WorkspaceScope, projectId: string) {
  return invalidateProject(queryClient, scope, projectId);
}

export function invalidateAfterNotifyPreference(queryClient: QueryClient, scope: WorkspaceScope, projectId: string) {
  return invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.detail, projectId);
}

/** After a Project moved folders: lists and folder counts. */
export async function invalidateAfterProjectMoved(queryClient: QueryClient, scope: WorkspaceScope, projectId: string) {
  await Promise.all([
    invalidateProjectCollections(queryClient, scope),
    invalidateScoped(queryClient, scope, "library", "folders"),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.detail, projectId),
  ]);
}

/**
 * After a Project was deleted (or found already gone): drop its cached reads
 * rather than refetching a 404, then refresh lists, folder counts and ingest
 * resume. The caller navigates to the explorer.
 */
export async function invalidateAfterProjectDeleted(queryClient: QueryClient, scope: WorkspaceScope, projectId: string) {
  queryClient.removeQueries({ queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.detail, projectId) as unknown[] });
  queryClient.removeQueries({ queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.snapshot, projectId) as unknown[] });
  await Promise.all([
    invalidateProjectCollections(queryClient, scope),
    invalidateScoped(queryClient, scope, "library", "folders"),
    invalidateScoped(queryClient, scope, "ingest", "resume"),
    invalidateWorkspaceUsage(queryClient, scope),
  ]);
}
