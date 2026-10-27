import { notFound } from "next/navigation";
import { admitProjectPage } from "@/lib/authenticated-request-page";
import { clipExportService, getLastWorkflowSeq } from "@narriflow/services";
import { planFeatureRequirement, workspaceAllowsCapability } from "@narriflow/validators";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { ExportDeliveryClient } from "./export-delivery-client";

export default async function ClipExportPage({
  params,
}: {
  params: Promise<{ projectId: string; clipId: string; exportId: string }>;
}) {
  const { projectId, clipId, exportId } = await params;
  const appUser = await admitProjectPage(projectId, "content.download");
  const [exported, initialSeq] = await Promise.all([
    clipExportService.getOwned(appUser, projectId, clipId, exportId),
    getLastWorkflowSeq(projectId),
  ]);
  if (!exported) notFound();
  return (
    <ExportDeliveryClient
      initialExport={exported}
      initialSeq={initialSeq}
      timelineRequirement={planFeatureRequirement(appUser.pricingTier, "export.timelines")?.message ?? null}
      timelineUpgrade={featureUpgradePrompt(appUser.pricingTier, "export.timelines", "Upgrade to edit in your own editor")}
      canEdit={workspaceAllowsCapability({ role: appUser.role, status: appUser.status }, "content.edit")}
      publishingUpgrade={featureUpgradePrompt(appUser.pricingTier, "publishing.schedule", "Upgrade to publish your clips")}
    />
  );
}
