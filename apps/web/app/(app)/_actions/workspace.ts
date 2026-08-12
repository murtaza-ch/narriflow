"use server";

import { revalidatePath } from "next/cache";
import { setActiveWorkspace } from "@narriflow/auth";

export async function switchWorkspaceAction(workspaceId: string) {
  await setActiveWorkspace(workspaceId);
  revalidatePath("/", "layout");
}
