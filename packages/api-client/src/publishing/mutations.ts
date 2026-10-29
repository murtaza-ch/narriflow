import type { QueryClient } from "@tanstack/query-core";
import { type WorkspaceScope, IDEMPOTENCY_KEY_HEADER, invalidateScoped } from "../core";
import { invalidateProject } from "../projects";
import { PROJECT_RESOURCES } from "../projects/queries";
import type { PublishingClient } from "./client";

type JsonOf<Endpoint extends { $post: (args: any) => unknown }> = Parameters<Endpoint["$post"]>[0] extends {
  json: infer Body;
}
  ? Body
  : never;

export type ProposeInput = JsonOf<PublishingClient["social"]["proposals"]>;
export type AcceptProposalInput = JsonOf<PublishingClient["social"]["proposals"][":proposalId"]["accept"]>;
export type RecheckInput = JsonOf<PublishingClient["projects"][":id"]["social-posts"][":postId"]["recheck"]>;
export type ConfirmInput = JsonOf<PublishingClient["projects"][":id"]["social-posts"][":postId"]["confirm"]>;
export type RepublishInput = JsonOf<PublishingClient["projects"][":id"]["social-posts"][":postId"]["publish-again"]>;

const keyed = (idempotencyKey: string) => ({ headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } });

/**
 * Publishing commands. The four retryable ones (propose and the three
 * recovery decisions) take the intent's `idempotencyKey`; keep it through a
 * retry and drop it once the command is confirmed (`runtime.createIntent`).
 * Accepting, rejecting and bulk scheduling carry their own native identity.
 */
export function publishingCommands(client: PublishingClient) {
  return {
    /** Returns the provider URL to navigate to; a plain link cannot carry the Bearer token. */
    startSocialOAuth: async (platform: Parameters<PublishingClient["social"]["oauth"]["start"][":platform"]["$post"]>[0]["param"]["platform"], redirect?: string) =>
      (await client.social.oauth.start[":platform"].$post({ param: { platform }, json: redirect ? { redirect } : {} })).json(),
    disconnectAccount: async (accountId: string) =>
      (await client.social.accounts[":accountId"].$delete({ param: { accountId } })).json(),
    savePostingSchedule: async (
      accountId: string,
      schedule: Parameters<PublishingClient["social"]["accounts"][":accountId"]["posting-schedule"]["$put"]>[0]["json"]["schedule"],
    ) =>
      (await client.social.accounts[":accountId"]["posting-schedule"].$put({ param: { accountId }, json: { schedule } })).json(),
    propose: async (input: ProposeInput, idempotencyKey: string) =>
      (await client.social.proposals.$post({ json: input }, keyed(idempotencyKey))).json(),
    updateProposalCaption: async (proposalId: string, caption: string) =>
      (await client.social.proposals[":proposalId"].$patch({ param: { proposalId }, json: { caption } })).json(),
    rejectProposal: async (proposalId: string) =>
      (await client.social.proposals[":proposalId"].reject.$post({ param: { proposalId } })).json(),
    acceptProposal: async (proposalId: string, choices: AcceptProposalInput = {}) =>
      (await client.social.proposals[":proposalId"].accept.$post({ param: { proposalId }, json: choices })).json(),
    /** One batch; call again with `nextCursor` until it is null. */
    acceptAllProposals: async (after: string | null = null) =>
      (await client.social.proposals["accept-all"].$post({ json: { after } })).json(),
    cancelPost: async (projectId: string, postId: string) =>
      (await client.projects[":id"]["social-posts"][":postId"].$delete({ param: { id: projectId, postId } })).json(),
    recheck: async (projectId: string, postId: string, input: RecheckInput, idempotencyKey: string) =>
      (await client.projects[":id"]["social-posts"][":postId"].recheck.$post({ param: { id: projectId, postId }, json: input }, keyed(idempotencyKey))).json(),
    confirm: async (projectId: string, postId: string, input: ConfirmInput, idempotencyKey: string) =>
      (await client.projects[":id"]["social-posts"][":postId"].confirm.$post({ param: { id: projectId, postId }, json: input }, keyed(idempotencyKey))).json(),
    publishAgain: async (projectId: string, postId: string, input: RepublishInput, idempotencyKey: string) =>
      (await client.projects[":id"]["social-posts"][":postId"]["publish-again"].$post({ param: { id: projectId, postId }, json: input }, keyed(idempotencyKey))).json(),
  };
}

/** Refreshes only the publishing reads of this identity + Workspace. Prefer the command-specific invalidators below. */
export function invalidatePublishing(queryClient: QueryClient, scope: WorkspaceScope): Promise<void> {
  return invalidateScoped(queryClient, scope, "publishing");
}

/**
 * A Project's post was cancelled, rechecked, confirmed or published again: the
 * publishing reads and that Project's own screen, whose tabs keep the post
 * list under `projects/detail/<id>/<tab>`.
 */
export async function invalidateAfterPostChange(
  queryClient: QueryClient,
  scope: WorkspaceScope,
  projectId: string,
): Promise<void> {
  await Promise.all([invalidatePublishing(queryClient, scope), invalidateProject(queryClient, scope, projectId)]);
}

/**
 * A proposal was accepted, rejected or edited, or a queue slot changed. Accepting
 * schedules a post on a Project the caller may not know, so every opened Project
 * screen is marked stale (only cached ones; nothing else is refetched).
 */
export async function invalidateAfterProposalChange(queryClient: QueryClient, scope: WorkspaceScope): Promise<void> {
  await Promise.all([
    invalidatePublishing(queryClient, scope),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.detail),
  ]);
}

/**
 * An account was connected, disconnected or rescheduled. Project screens carry
 * account snapshots, Recipes and Autopilot offer accounts as choices, Standing
 * Grants name destinations, and the Integrations overview lists the accounts.
 */
export async function invalidateAfterAccountChange(queryClient: QueryClient, scope: WorkspaceScope): Promise<void> {
  await Promise.all([
    invalidatePublishing(queryClient, scope),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.detail),
    invalidateScoped(queryClient, scope, "recipes"),
    invalidateScoped(queryClient, scope, "automation", "overview"),
    invalidateScoped(queryClient, scope, "automation", "rules"),
    invalidateScoped(queryClient, scope, "automation", "standing-grants"),
    invalidateScoped(queryClient, scope, "developer", "overview"),
  ]);
}
