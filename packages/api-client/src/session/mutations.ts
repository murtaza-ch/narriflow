import { mutationOptions } from "@tanstack/react-query";
import { type ApiRuntime, type IdentityScope, sessionKey } from "../core";
import { createSessionClient } from "./client";
import { invalidateSessionBootstrap } from "./queries";

/**
 * Switches Workspace. Only membership is checked, so a member of a restricted
 * Workspace can still leave it. On success the runtime adopts the selection
 * first (cancelling and clearing the old Workspace's queries); the caller then
 * navigates. Navigation and any full cache reset belong to the app.
 */
export function selectWorkspaceMutation(api: ApiRuntime, scope: IdentityScope) {
  const client = createSessionClient(api.transport.identity(scope));
  return mutationOptions({
    mutationKey: sessionKey(scope, "select-workspace"),
    mutationFn: async (workspaceId: string) => {
      const response = await client.session["workspace-selection"].$post({ json: { workspaceId } });
      return response.json();
    },
    // The bootstrap lists memberships, which a switch does not change; refetching it here
    // would send the previous hint, because the gate has not rendered the new one yet.
    onSuccess: (selection) => {
      api.selectWorkspace(selection.workspace.id);
    },
  });
}

/**
 * Accepts an invitation (the signed-in person's email must match). The response
 * names the joined Workspace as the explicit selection plus where to go next;
 * nothing is stored server-side. Not retried automatically: a token is single-use.
 */
export function acceptInviteMutation(api: ApiRuntime, scope: IdentityScope) {
  const client = createSessionClient(api.transport.identity(scope));
  return mutationOptions({
    mutationKey: sessionKey(scope, "accept-invite"),
    mutationFn: async (token: string) => {
      const response = await client.invites[":token"].accept.$post({ param: { token } });
      return response.json();
    },
    onSuccess: async (accepted) => {
      api.selectWorkspace(accepted.workspace.id);
      await invalidateSessionBootstrap(api.queryClient, scope);
    },
  });
}
