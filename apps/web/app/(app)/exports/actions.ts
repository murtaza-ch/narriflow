"use server";

import { revalidatePath } from "next/cache";
import { clipExportService } from "@narriflow/services";
import { requireWorkspaceAppUser } from "@/lib/workspace";

export async function retryWorkspaceExportAction(exportId: string) {
  const appUser = await requireWorkspaceAppUser("processing.consume");
  const exported = await clipExportService.getWorkspaceOwned(
    appUser.workspaceId,
    exportId,
  );
  if (!exported) throw new Error("Export not found");
  await clipExportService.retryFailed(
    appUser.id,
    exported.projectId,
    exported.clipId,
    exported.id,
    appUser.workspaceId,
  );
  revalidatePath("/exports");
}
