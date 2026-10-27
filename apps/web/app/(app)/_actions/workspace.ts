"use server";

import { revalidatePath } from "next/cache";
import { setActiveWorkspaceForActor } from "@narriflow/auth";
import { workspaceSelectionActionSchema } from "@narriflow/validators";
import { executeSignedInActionWithInput } from "@/lib/authenticated-request-action";

/**
 * Switching needs only membership of the target workspace, which
 * `setActiveWorkspaceForActor` checks. It must not depend on the current
 * workspace: a member of a paused workspace has no access there and needs a way out.
 */
export async function switchWorkspaceAction(workspaceId: string) {
  return executeSignedInActionWithInput({ workspaceId }, workspaceSelectionActionSchema, async (actor, input) => {
    await setActiveWorkspaceForActor(actor.actorUserId, input.workspaceId);
    revalidatePath("/", "layout");
  });
}
