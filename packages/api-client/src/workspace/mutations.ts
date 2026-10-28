import type {
  ChangeMemberRoleRequest,
  InviteMemberRequest,
  ReplaceCensorWordsRequest,
  UpdateWorkspaceRequest,
} from "@narriflow/validators/api/workspace";
import { mutationOptions } from "@tanstack/react-query";
import { type ApiRuntime, IDEMPOTENCY_KEY_HEADER, invalidateScoped, scopedKey, type WorkspaceScope } from "../core";
import { createWorkspaceClient } from "./client";
import { invalidateWorkspaceMembers, invalidateWorkspaceProfile } from "./queries";

const key = (scope: WorkspaceScope, command: string) => scopedKey(scope, "workspace", command);
const clientFor = (api: ApiRuntime, scope: WorkspaceScope) => createWorkspaceClient(api.transport.scoped(scope));

/** Name and timezone. */
export function updateWorkspaceMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "update"),
    mutationFn: async (input: UpdateWorkspaceRequest) => (await client.workspace.$patch({ json: input })).json(),
    onSuccess: () => invalidateWorkspaceProfile(api.queryClient, scope),
  });
}

/** Step one of an avatar change: a short-lived upload URL (the upload itself carries no session credential). */
export function presignAvatarMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "avatar-presign"),
    mutationFn: async (input: { contentType: string; sizeBytes: number }) =>
      (await client.workspace.avatar.presign.$post({ json: input })).json(),
  });
}

/** Step two: records the uploaded object's key, or `null` to remove the avatar. */
export function setAvatarMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "avatar"),
    mutationFn: async (storageKey: string | null) =>
      (await client.workspace.avatar.$patch({ json: { storageKey } })).json(),
    onSuccess: () => invalidateWorkspaceProfile(api.queryClient, scope),
  });
}

/** "Use my performance data to pick clips". */
export function performanceGuidanceMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "performance-guidance"),
    mutationFn: async (enabled: boolean) =>
      (await client.workspace["performance-guidance"].$patch({ json: { enabled } })).json(),
    // The guidance read lives with publishing/performance, keyed `publishing/guidance`.
    onSuccess: () => invalidateScoped(api.queryClient, scope, "publishing", "guidance"),
  });
}

/**
 * Invites a member. Create one per form (the factory owns the idempotency
 * intent): a retry after a lost response replays the same invitation instead of
 * sending a second one. A replay returns `inviteUrl: null`; use `resendInviteMutation`.
 */
export function inviteMemberMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  const intent = api.createIntent<InviteMemberRequest>();
  return mutationOptions({
    mutationKey: key(scope, "invite"),
    mutationFn: async (input: InviteMemberRequest) =>
      (
        await client.workspace.invites.$post(
          { json: input },
          { headers: { [IDEMPOTENCY_KEY_HEADER]: intent.keyFor(input) } },
        )
      ).json(),
    onSuccess: async () => {
      intent.complete();
      await invalidateWorkspaceMembers(api.queryClient, scope);
    },
  });
}

/** Sends the person a fresh link. One factory per row; the intent is keyed by the invite. */
export function resendInviteMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  const intent = api.createIntent<string>();
  return mutationOptions({
    mutationKey: key(scope, "resend-invite"),
    mutationFn: async (inviteId: string) =>
      (
        await client.workspace.invites[":inviteId"].resend.$post(
          { param: { inviteId } },
          { headers: { [IDEMPOTENCY_KEY_HEADER]: intent.keyFor(inviteId) } },
        )
      ).json(),
    onSuccess: async () => {
      intent.complete();
      await invalidateWorkspaceMembers(api.queryClient, scope);
    },
  });
}

export function revokeInviteMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "revoke-invite"),
    mutationFn: async (inviteId: string) =>
      (await client.workspace.invites[":inviteId"].$delete({ param: { inviteId } })).json(),
    onSuccess: () => invalidateWorkspaceMembers(api.queryClient, scope),
  });
}

export function changeMemberRoleMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "change-member-role"),
    mutationFn: async (input: { memberId: string } & ChangeMemberRoleRequest) =>
      (
        await client.workspace.members[":memberId"].$patch({
          param: { memberId: input.memberId },
          json: { role: input.role },
        })
      ).json(),
    onSuccess: () => invalidateWorkspaceMembers(api.queryClient, scope),
  });
}

export function removeMemberMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "remove-member"),
    mutationFn: async (memberId: string) =>
      (await client.workspace.members[":memberId"].$delete({ param: { memberId } })).json(),
    onSuccess: () => invalidateWorkspaceMembers(api.queryClient, scope),
  });
}

/** Replaces the whole censored-word list. The saved list becomes the cached one. */
export function replaceCensorWordsMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "replace-censor-words"),
    mutationFn: async (input: ReplaceCensorWordsRequest) =>
      (await client.workspace["censor-words"].$put({ json: input })).json(),
    onSuccess: (saved) => {
      api.queryClient.setQueryData(scopedKey(scope, "workspace", "censor-words"), saved);
      return invalidateScoped(api.queryClient, scope, "workspace", "censor-words");
    },
  });
}

/** Back to the built-in defaults. */
export function resetCensorWordsMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "reset-censor-words"),
    mutationFn: async () => (await client.workspace["censor-words"].$delete()).json(),
    onSuccess: (saved) => {
      api.queryClient.setQueryData(scopedKey(scope, "workspace", "censor-words"), saved);
      return invalidateScoped(api.queryClient, scope, "workspace", "censor-words");
    },
  });
}
