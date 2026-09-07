"use server";

import { revalidatePath } from "next/cache";
import { clipExportService } from "@narriflow/services";
import { executeWorkspaceAction } from "@/lib/authenticated-request-action";

export async function retryWorkspaceExportAction(exportId: string) {
  return executeWorkspaceAction("processing.consume", async (appUser) => {
    const exported = await clipExportService.getWorkspaceOwned(
      appUser.workspaceId,
      exportId,
    );
    if (!exported) throw new Error("Export not found");
    await clipExportService.retryFailed(
      appUser.workspaceOwnerUserId,
      exported.projectId,
      exported.clipId,
      exported.id,
      appUser.workspaceId,
    );
    revalidatePath("/exports");
  });
}
