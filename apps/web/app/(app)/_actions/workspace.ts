"use server";

import { revalidatePath } from "next/cache";
import { setActiveWorkspaceForActor } from "@narriflow/auth";
import { workspaceSelectionActionSchema } from "@narriflow/validators";
import { executeWorkspaceActionWithInput } from "@/lib/authenticated-request-action";

export async function switchWorkspaceAction(workspaceId: string) {
  return executeWorkspaceActionWithInput("content.view", { workspaceId }, workspaceSelectionActionSchema, async (actor, input) => {
    await setActiveWorkspaceForActor(actor.actorUserId, input.workspaceId);
    revalidatePath("/", "layout");
  });
}
