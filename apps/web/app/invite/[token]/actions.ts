"use server";

import { redirect } from "next/navigation";
import { setActiveWorkspaceForActor } from "@narriflow/auth";
import { workspaceMembershipService } from "@narriflow/services";
import { workspaceInviteAcceptanceActionSchema } from "@narriflow/validators";
import {
  authenticatedActionResultError,
  executeSignedInActionWithInput,
} from "@/lib/authenticated-request-action";

export async function acceptWorkspaceInviteAction(token: string) {
  return executeSignedInActionWithInput(
    { token },
    workspaceInviteAcceptanceActionSchema,
    async (appUser, input) => {
      let accepted;
      try {
        accepted = await workspaceMembershipService.acceptInvite(
          appUser.actorUserId,
          input.token,
        );
      } catch (error) {
        const failure = authenticatedActionResultError(
          error,
          "The invitation could not be accepted",
        );
        return {
          ok: false as const,
          error: failure.errorCode,
          code: failure.errorCode,
          message: failure.message,
        };
      }
      await setActiveWorkspaceForActor(appUser.actorUserId, accepted.workspaceId);
      redirect("/home");
    },
  );
}
