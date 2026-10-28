import { type WorkspaceScope, scopedKey } from "../core";
import type { PublishingClient } from "./index";

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
