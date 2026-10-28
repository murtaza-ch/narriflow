import type { QueryClient } from "@tanstack/query-core";
import { type WorkspaceScope, IDEMPOTENCY_KEY_HEADER, invalidateScoped } from "../core";
import type { PublishingClient } from "./index";

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

/** Refreshes every publishing read of this identity + Workspace after a command; nothing broader. */
export function invalidatePublishing(queryClient: QueryClient, scope: WorkspaceScope): Promise<void> {
  return invalidateScoped(queryClient, scope, "publishing");
}
