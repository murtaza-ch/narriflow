import { notFound } from "next/navigation";
import { requireCurrentAppUser } from "@narriflow/auth";
import { clipExportService, getLastWorkflowSeq } from "@narriflow/services";
import { ExportDeliveryClient } from "./export-delivery-client";

export default async function ClipExportPage({
  params,
}: {
  params: Promise<{ projectId: string; clipId: string; exportId: string }>;
}) {
  const appUser = await requireCurrentAppUser();
  const { projectId, clipId, exportId } = await params;
  const [exported, initialSeq] = await Promise.all([
    clipExportService.getOwned(appUser.id, projectId, clipId, exportId),
    getLastWorkflowSeq(projectId),
  ]);
  if (!exported) notFound();
  return <ExportDeliveryClient initialExport={exported} initialSeq={initialSeq} />;
}
