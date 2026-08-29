import { notFound } from "next/navigation";
import { admitProjectPage } from "@/lib/authenticated-request-page";
import { clipExportService, getLastWorkflowSeq } from "@narriflow/services";
import { ExportDeliveryClient } from "./export-delivery-client";

export default async function ClipExportPage({
  params,
}: {
  params: Promise<{ projectId: string; clipId: string; exportId: string }>;
}) {
  const { projectId, clipId, exportId } = await params;
  const appUser = await admitProjectPage(projectId, "content.download");
  const [exported, initialSeq] = await Promise.all([
    clipExportService.getOwned(
      appUser.workspaceOwnerUserId,
      projectId,
      clipId,
      exportId,
      appUser.workspaceId,
    ),
    getLastWorkflowSeq(projectId),
  ]);
  if (!exported) notFound();
  return (
    <ExportDeliveryClient initialExport={exported} initialSeq={initialSeq} />
  );
}
