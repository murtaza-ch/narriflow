import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { scopedKey, STALE_TIME, type WorkspaceScope } from "../core";
import type { ProjectTab } from "@narriflow/validators/api/projects";
import { canonicalListFilters, listRequestQuery, type ProjectListFilters } from "./filters";
import type { ProjectsClient } from "./index";

type Ok<Endpoint extends (...args: never[]) => Promise<unknown>> = InferResponseType<Endpoint, 200>;

type Init = { init: { signal: AbortSignal } };
const withSignal = (signal: AbortSignal): Init => ({ init: { signal } });

export type HomeData = Ok<ProjectsClient["home"]["$get"]>;
export type ExplorerData = Ok<ProjectsClient["projects"]["explorer"]["$get"]>;
export type ProjectListPage = Ok<ProjectsClient["projects"]["$get"]>;
export type ProjectDetail = Ok<ProjectsClient["projects"][":id"]["detail"]["$get"]>;
export type ProjectSnapshotData = Ok<ProjectsClient["projects"][":id"]["$get"]>;

/** Query-key resources of the projects domain; `invalidate.ts` is the only place that targets them in bulk. */
export const PROJECT_RESOURCES = {
  home: "home",
  explorer: "explorer",
  list: "list",
  detail: "detail",
  snapshot: "snapshot",
  transcript: "transcript",
  contentPack: "content-pack",
  workflowHistory: "workflow-history",
  finishing: "finishing",
  creditUsage: "credit-usage",
  sourceUrl: "source-url",
  dubsAllowance: "dubs-allowance",
} as const;

/**
 * Query factories of the projects domain. Each takes the typed client and the
 * captured Workspace scope, and returns options for `useQuery` and friends;
 * pages never build URLs. Every function passes the abort signal through.
 */
export const projectQueries = {
  /** Recent Projects and the dashboard's access facts. */
  home(client: ProjectsClient, scope: WorkspaceScope) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.home),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }): Promise<HomeData> =>
        (await client.home.$get(undefined, withSignal(signal))).json() as Promise<HomeData>,
    });
  },

  /** The explorer's first page with folders, filter facts and access, in one request. */
  explorer(client: ProjectsClient, scope: WorkspaceScope, filters: ProjectListFilters = {}) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.explorer, canonicalListFilters(filters)),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }): Promise<ExplorerData> =>
        (
          await client.projects.explorer.$get({ query: listRequestQuery(filters) }, withSignal(signal))
        ).json() as Promise<ExplorerData>,
    });
  },

  /** Every page of a filtered list, for "load more". The first page equals the explorer's `page`. */
  list(client: ProjectsClient, scope: WorkspaceScope, filters: ProjectListFilters = {}) {
    return infiniteQueryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.list, canonicalListFilters(filters)),
      staleTime: STALE_TIME.default,
      initialPageParam: null as string | null,
      queryFn: async ({ pageParam, signal }): Promise<ProjectListPage> =>
        (
          await client.projects.$get({ query: listRequestQuery(filters, pageParam) }, withSignal(signal))
        ).json() as Promise<ProjectListPage>,
      getNextPageParam: (last: ProjectListPage) => last.nextCursor,
    });
  },

  /**
   * The Project screen: snapshot, clips, usage and the active tab's data. The
   * key is `[..., 'detail', projectId, tab]`, so invalidating `('detail', projectId)`
   * refreshes every tab that was opened.
   */
  detail(client: ProjectsClient, scope: WorkspaceScope, projectId: string, tab: ProjectTab = "clips") {
    return queryOptions({
      queryKey: [...scopedKey(scope, "projects", PROJECT_RESOURCES.detail, projectId), tab],
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }): Promise<ProjectDetail> =>
        (
          await client.projects[":id"].detail.$get({ param: { id: projectId }, query: { tab } }, withSignal(signal))
        ).json() as Promise<ProjectDetail>,
    });
  },

  /** The snapshot alone, for polling an active run without re-reading every tab. */
  snapshot(client: ProjectsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.snapshot, projectId),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }): Promise<ProjectSnapshotData> =>
        (
          await client.projects[":id"].$get({ param: { id: projectId } }, withSignal(signal))
        ).json() as Promise<ProjectSnapshotData>,
    });
  },

  /** Only the transcript's status, which is all the shell needs. */
  transcriptStatus(client: ProjectsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.transcript, { id: projectId, view: "status" }),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }) =>
        (
          await client.projects[":id"].transcript.$get(
            { param: { id: projectId }, query: { view: "status" } },
            withSignal(signal),
          )
        ).json(),
    });
  },

  /** The full transcript. Only the transcript tab asks for it. */
  transcript(client: ProjectsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.transcript, { id: projectId, view: "full" }),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }) =>
        (
          await client.projects[":id"].transcript.$get(
            { param: { id: projectId }, query: { view: "full" } },
            withSignal(signal),
          )
        ).json(),
    });
  },

  contentPack(client: ProjectsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.contentPack, projectId),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }) =>
        (await client.projects[":id"]["content-pack"].$get({ param: { id: projectId } }, withSignal(signal))).json(),
    });
  },

  /** Recent workflow events, to seed the activity list before the progress stream takes over. */
  workflowHistory(client: ProjectsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.workflowHistory, projectId),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }) =>
        (await client.projects[":id"]["workflow-history"].$get({ param: { id: projectId } }, withSignal(signal))).json(),
    });
  },

  finishing(client: ProjectsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.finishing, projectId),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }) =>
        (await client.projects[":id"].finishing.$get({ param: { id: projectId } }, withSignal(signal))).json(),
    });
  },

  creditUsage(client: ProjectsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.creditUsage, projectId),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }) =>
        (await client.projects[":id"]["credit-usage"].$get({ param: { id: projectId } }, withSignal(signal))).json(),
    });
  },

  /**
   * A short-lived grant for the source video. Refetch after `expiresAt`
   * (for example when the tab resumes); the URL never carries Clerk credentials.
   */
  sourceUrl(client: ProjectsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.sourceUrl, projectId),
      staleTime: STALE_TIME.live,
      queryFn: async ({ signal }) =>
        (await client.projects[":id"]["source-url"].$get({ param: { id: projectId } }, withSignal(signal))).json(),
    });
  },

  dubsAllowance(client: ProjectsClient, scope: WorkspaceScope, projectId: string) {
    return queryOptions({
      queryKey: scopedKey(scope, "projects", PROJECT_RESOURCES.dubsAllowance, projectId),
      staleTime: STALE_TIME.default,
      queryFn: async ({ signal }) =>
        (await client.projects[":id"].dubs.allowance.$get({ param: { id: projectId } }, withSignal(signal))).json(),
    });
  },
};
