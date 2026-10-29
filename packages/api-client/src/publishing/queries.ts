import { queryOptions } from "@tanstack/react-query";
import { type ApiTransport, STALE_TIME, type WorkspaceScope, scopedKey } from "../core";
import { createPublishingClient, type PublishingClient } from "./client";
import { publishingCommands } from "./mutations";

/** Query inputs, taken from the route types so a changed server schema fails to compile here. */
type QueryOf<Endpoint extends { $get: (args: any) => unknown }> = Parameters<Endpoint["$get"]>[0] extends {
  query: infer Query;
}
  ? Query
  : never;

export type CalendarQuery = QueryOf<PublishingClient["publishing"]["calendar"]>;
export type CalendarPostsQuery = QueryOf<PublishingClient["workspace"]["calendar"]["posts"]>;
export type ComposerOptionsQuery = QueryOf<PublishingClient["workspace"]["calendar"]["composer-options"]>;
export type ProjectPostsQuery = QueryOf<PublishingClient["projects"][":id"]["social-posts"]>;

const DOMAIN = "publishing" as const;

/**
 * Keys of the publishing reads, all inside one identity + Workspace. Every key
 * starts with `publishingKeys.all(scope)`, so one invalidation refreshes the
 * calendar, queue, proposals and project posts after any publishing command.
 */
export const publishingKeys = {
  all: (scope: WorkspaceScope) => scopedKey(scope, DOMAIN),
  accounts: (scope: WorkspaceScope) => scopedKey(scope, DOMAIN, "accounts"),
  calendar: (scope: WorkspaceScope, query: CalendarQuery) => scopedKey(scope, DOMAIN, "calendar", query),
  calendarPosts: (scope: WorkspaceScope, query: CalendarPostsQuery) => scopedKey(scope, DOMAIN, "calendar-posts", query),
  calendarFilters: (scope: WorkspaceScope) => scopedKey(scope, DOMAIN, "calendar-filters"),
  composerOptions: (scope: WorkspaceScope, query: ComposerOptionsQuery) => scopedKey(scope, DOMAIN, "composer-options", query),
  queue: (scope: WorkspaceScope) => scopedKey(scope, DOMAIN, "queue"),
  proposals: (scope: WorkspaceScope) => scopedKey(scope, DOMAIN, "proposals"),
  proposalCount: (scope: WorkspaceScope) => scopedKey(scope, DOMAIN, "proposal-count"),
  postingSchedule: (scope: WorkspaceScope, accountId: string) => scopedKey(scope, DOMAIN, "posting-schedule", { accountId }),
  tiktokOptions: (scope: WorkspaceScope, accountId: string) => scopedKey(scope, DOMAIN, "tiktok-options", { accountId }),
  projectPosts: (scope: WorkspaceScope, projectId: string, query: ProjectPostsQuery = {}) =>
    scopedKey(scope, DOMAIN, "project-posts", { projectId, ...query }),
  publication: (scope: WorkspaceScope, projectId: string, postId: string) =>
    scopedKey(scope, DOMAIN, "publication", { projectId, postId }),
  whatWorked: (scope: WorkspaceScope) => scopedKey(scope, DOMAIN, "what-worked"),
  guidance: (scope: WorkspaceScope) => scopedKey(scope, DOMAIN, "guidance"),
};

/**
 * Fetchers for the publishing reads. The transport throws a typed `ApiError`
 * for any failed status, so each function returns the success body.
 */
export function publishingReads(client: PublishingClient) {
  return {
    accounts: async () => (await client.social.accounts.$get()).json(),
    calendar: async (query: CalendarQuery) => (await client.publishing.calendar.$get({ query })).json(),
    calendarPosts: async (query: CalendarPostsQuery) => (await client.workspace.calendar.posts.$get({ query })).json(),
    calendarFilters: async () => (await client.workspace.calendar.filters.$get()).json(),
    composerOptions: async (query: ComposerOptionsQuery) =>
      (await client.workspace.calendar["composer-options"].$get({ query })).json(),
    queue: async () => (await client.publishing.queue.$get()).json(),
    proposals: async () => (await client.publishing.proposals.$get()).json(),
    proposalCount: async () => (await client.publishing.proposals.count.$get()).json(),
    postingSchedule: async (accountId: string) =>
      (await client.social.accounts[":accountId"]["posting-schedule"].$get({ param: { accountId } })).json(),
    tiktokOptions: async (accountId: string) =>
      (await client.social.accounts[":accountId"]["tiktok-options"].$get({ param: { accountId } })).json(),
    projectPosts: async (projectId: string, query: ProjectPostsQuery = {}) =>
      (await client.projects[":id"]["social-posts"].$get({ param: { id: projectId }, query })).json(),
    publication: async (projectId: string, postId: string) =>
      (await client.projects[":id"]["social-posts"][":postId"].publication.$get({ param: { id: projectId, postId } })).json(),
    whatWorked: async () => (await client.performance["what-worked"].$get()).json(),
    guidance: async () => (await client.performance.guidance.$get()).json(),
  };
}

/** The client for one scope; the signal ends the request when the query or screen goes away. */
export function publishingClientFor(
  transport: ApiTransport,
  scope: WorkspaceScope,
  signal?: AbortSignal,
): PublishingClient {
  const bound = transport.scoped(scope);
  return createPublishingClient({
    baseUrl: bound.baseUrl,
    fetch: (input, init) => bound.fetch(input, signal ? { ...init, signal } : init),
  });
}

/** The client, its read fetchers and its commands for one scope; the signal reaches every request. */
export function publishingApi(transport: ApiTransport, scope: WorkspaceScope, signal?: AbortSignal) {
  const client = publishingClientFor(transport, scope, signal);
  return { reads: publishingReads(client), commands: publishingCommands(client), client };
}

type Runtime = { transport: ApiTransport };

/**
 * `queryOptions` for the publishing reads, keyed by `publishingKeys` and passing
 * the query's AbortSignal to the request. Screens add their own cadence
 * (`refetchInterval`) on top.
 */
export const publishingQueries = {
  accounts: (runtime: Runtime, scope: WorkspaceScope) =>
    queryOptions({
      queryKey: publishingKeys.accounts(scope),
      queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.accounts(),
      staleTime: STALE_TIME.default,
    }),
  calendar: (runtime: Runtime, scope: WorkspaceScope, query: CalendarQuery) =>
    queryOptions({
      queryKey: publishingKeys.calendar(scope, query),
      queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.calendar(query),
      staleTime: STALE_TIME.default,
    }),
  composerOptions: (runtime: Runtime, scope: WorkspaceScope, query: ComposerOptionsQuery) =>
    queryOptions({
      queryKey: publishingKeys.composerOptions(scope, query),
      queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.composerOptions(query),
      staleTime: STALE_TIME.default,
    }),
  queue: (runtime: Runtime, scope: WorkspaceScope) =>
    queryOptions({
      queryKey: publishingKeys.queue(scope),
      queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.queue(),
      staleTime: STALE_TIME.default,
    }),
  whatWorked: (runtime: Runtime, scope: WorkspaceScope) =>
    queryOptions({
      queryKey: publishingKeys.whatWorked(scope),
      queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.whatWorked(),
      staleTime: STALE_TIME.default,
    }),
  /** Keyed where the Workspace guidance setting invalidates it. */
  guidance: (runtime: Runtime, scope: WorkspaceScope) =>
    queryOptions({
      queryKey: publishingKeys.guidance(scope),
      queryFn: ({ signal }) => publishingApi(runtime.transport, scope, signal).reads.guidance(),
      staleTime: STALE_TIME.default,
    }),
};
