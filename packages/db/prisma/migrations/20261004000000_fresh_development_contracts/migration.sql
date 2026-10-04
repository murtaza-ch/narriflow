-- Current contracts for fresh development data. Unknown stored formats are rejected.
BEGIN;

-- CreateEnum
CREATE TYPE "ClipRenderFailureDisposition" AS ENUM ('retryable', 'permanent');

-- AlterEnum
CREATE TYPE "ClipStatus_new" AS ENUM ('detected', 'edited');
ALTER TABLE "Clip" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Clip" ALTER COLUMN "status" TYPE "ClipStatus_new" USING ("status"::text::"ClipStatus_new");
ALTER TYPE "ClipStatus" RENAME TO "ClipStatus_old";
ALTER TYPE "ClipStatus_new" RENAME TO "ClipStatus";
DROP TYPE "ClipStatus_old";
ALTER TABLE "Clip" ALTER COLUMN "status" SET DEFAULT 'detected';

-- DropForeignKey
ALTER TABLE "BrandProfile" DROP CONSTRAINT "BrandProfile_defaultIntroSceneTemplateId_fkey";

-- DropForeignKey
ALTER TABLE "BrandProfile" DROP CONSTRAINT "BrandProfile_defaultOutroSceneTemplateId_fkey";

-- DropForeignKey
ALTER TABLE "CampaignOperation" DROP CONSTRAINT "CampaignOperation_projectId_fkey";

-- DropForeignKey
ALTER TABLE "CampaignOperation" DROP CONSTRAINT "CampaignOperation_retryOfId_fkey";

-- DropForeignKey
ALTER TABLE "CampaignOperation" DROP CONSTRAINT "CampaignOperation_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "CampaignOperationItem" DROP CONSTRAINT "CampaignOperationItem_clipId_fkey";

-- DropForeignKey
ALTER TABLE "CampaignOperationItem" DROP CONSTRAINT "CampaignOperationItem_exportId_fkey";

-- DropForeignKey
ALTER TABLE "CampaignOperationItem" DROP CONSTRAINT "CampaignOperationItem_operationId_fkey";

-- DropForeignKey
ALTER TABLE "CampaignOperationItem" DROP CONSTRAINT "CampaignOperationItem_reviewApprovalOverrideId_fkey";

-- DropForeignKey
ALTER TABLE "ExportBundle" DROP CONSTRAINT "ExportBundle_operationId_fkey";

-- DropForeignKey
ALTER TABLE "ExportBundle" DROP CONSTRAINT "ExportBundle_workflowRunId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewApprovalOverride" DROP CONSTRAINT "ReviewApprovalOverride_exportId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewApprovalOverride" DROP CONSTRAINT "ReviewApprovalOverride_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewApprovalOverride" DROP CONSTRAINT "ReviewApprovalOverride_reviewRoundId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewApprovalOverride" DROP CONSTRAINT "ReviewApprovalOverride_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewAuditEvent" DROP CONSTRAINT "ReviewAuditEvent_guestId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewAuditEvent" DROP CONSTRAINT "ReviewAuditEvent_reviewRoundId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewComment" DROP CONSTRAINT "ReviewComment_authorGuestId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewComment" DROP CONSTRAINT "ReviewComment_itemId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewComment" DROP CONSTRAINT "ReviewComment_parentId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewComment" DROP CONSTRAINT "ReviewComment_reviewRoundId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewDecision" DROP CONSTRAINT "ReviewDecision_actorGuestId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewDecision" DROP CONSTRAINT "ReviewDecision_itemId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewDecision" DROP CONSTRAINT "ReviewDecision_reviewRoundId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewGuest" DROP CONSTRAINT "ReviewGuest_reviewRoundId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewNotificationLedger" DROP CONSTRAINT "ReviewNotificationLedger_reviewRoundId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewRound" DROP CONSTRAINT "ReviewRound_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewRound" DROP CONSTRAINT "ReviewRound_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewRoundContext" DROP CONSTRAINT "ReviewRoundContext_reviewRoundId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewRoundContext" DROP CONSTRAINT "ReviewRoundContext_sourceCommentId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewRoundItem" DROP CONSTRAINT "ReviewRoundItem_clipId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewRoundItem" DROP CONSTRAINT "ReviewRoundItem_exportId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewRoundItem" DROP CONSTRAINT "ReviewRoundItem_reviewRoundId_fkey";

-- DropForeignKey
ALTER TABLE "SceneTemplate" DROP CONSTRAINT "SceneTemplate_profileId_fkey";

-- DropForeignKey
ALTER TABLE "SceneTemplate" DROP CONSTRAINT "SceneTemplate_sourceAssetId_fkey";

-- DropForeignKey
ALTER TABLE "SocialPost" DROP CONSTRAINT "SocialPost_reviewApprovalOverrideId_fkey";

-- AlterTable
ALTER TABLE "BrandFont" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BrandProfile" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BrandProfileAsset" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BrandProfileAudio" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BrandProfileFont" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BrandProfileTemplate" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BrandTemplate" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Clip" ALTER COLUMN "editorDocumentVersion" SET DEFAULT 1;
ALTER TABLE "Clip" DROP CONSTRAINT "Clip_editorDocumentVersion_check";
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_editorDocumentVersion_check"
  CHECK ("editorDocumentVersion" = 1);

-- AlterTable
ALTER TABLE "ClipRender" DROP COLUMN "failureDisposition",
ADD COLUMN     "failureDisposition" "ClipRenderFailureDisposition";

-- AlterTable
ALTER TABLE "ContentAsset" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "FrozenPublicationState" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "GeneratedMediaUsageReservation" DROP COLUMN "reservedUnits";

-- AlterTable
ALTER TABLE "ProviderReceipt" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PublicationAnalyticsIntent" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ReviewRound" ALTER COLUMN "recipientEmails" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SocialPublicationAttempt" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "VisualAsset" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkflowEvent" ALTER COLUMN "dedupeKey" SET NOT NULL;

-- AlterTable
ALTER TABLE "Workspace" DROP COLUMN "seatLimit";

-- AlterTable
ALTER TABLE "WorkspaceBillingAccount" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceBillingTransition" DROP COLUMN "sourceEventId",
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceCheckoutAttempt" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceInvite" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceMember" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "CampaignOperation" ADD CONSTRAINT "CampaignOperation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignOperation" ADD CONSTRAINT "CampaignOperation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignOperation" ADD CONSTRAINT "CampaignOperation_retryOfId_fkey" FOREIGN KEY ("retryOfId") REFERENCES "CampaignOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignOperationItem" ADD CONSTRAINT "CampaignOperationItem_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "CampaignOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignOperationItem" ADD CONSTRAINT "CampaignOperationItem_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignOperationItem" ADD CONSTRAINT "CampaignOperationItem_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignOperationItem" ADD CONSTRAINT "CampaignOperationItem_reviewApprovalOverrideId_fkey" FOREIGN KEY ("reviewApprovalOverrideId") REFERENCES "ReviewApprovalOverride"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportBundle" ADD CONSTRAINT "ExportBundle_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "CampaignOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportBundle" ADD CONSTRAINT "ExportBundle_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRound" ADD CONSTRAINT "ReviewRound_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRound" ADD CONSTRAINT "ReviewRound_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRoundContext" ADD CONSTRAINT "ReviewRoundContext_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRoundContext" ADD CONSTRAINT "ReviewRoundContext_sourceCommentId_fkey" FOREIGN KEY ("sourceCommentId") REFERENCES "ReviewComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewNotificationLedger" ADD CONSTRAINT "ReviewNotificationLedger_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRoundItem" ADD CONSTRAINT "ReviewRoundItem_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRoundItem" ADD CONSTRAINT "ReviewRoundItem_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRoundItem" ADD CONSTRAINT "ReviewRoundItem_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ReviewRoundItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_authorGuestId_fkey" FOREIGN KEY ("authorGuestId") REFERENCES "ReviewGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ReviewComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ReviewRoundItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_actorGuestId_fkey" FOREIGN KEY ("actorGuestId") REFERENCES "ReviewGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewApprovalOverride" ADD CONSTRAINT "ReviewApprovalOverride_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewApprovalOverride" ADD CONSTRAINT "ReviewApprovalOverride_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewApprovalOverride" ADD CONSTRAINT "ReviewApprovalOverride_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewApprovalOverride" ADD CONSTRAINT "ReviewApprovalOverride_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewGuest" ADD CONSTRAINT "ReviewGuest_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewAuditEvent" ADD CONSTRAINT "ReviewAuditEvent_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewAuditEvent" ADD CONSTRAINT "ReviewAuditEvent_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "ReviewGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_defaultIntroSceneTemplateId_fkey" FOREIGN KEY ("defaultIntroSceneTemplateId") REFERENCES "SceneTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_defaultOutroSceneTemplateId_fkey" FOREIGN KEY ("defaultOutroSceneTemplateId") REFERENCES "SceneTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneTemplate" ADD CONSTRAINT "SceneTemplate_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneTemplate" ADD CONSTRAINT "SceneTemplate_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "VisualAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_reviewApprovalOverrideId_fkey" FOREIGN KEY ("reviewApprovalOverrideId") REFERENCES "ReviewApprovalOverride"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "CampaignOperation_workspaceId_projectId_action_idempotencyKey_k" RENAME TO "CampaignOperation_workspaceId_projectId_action_idempotencyK_key";

-- RenameIndex
ALTER INDEX "MediaCleanupObligation_completedAt_nextAttemptAt_claimExpiresAt" RENAME TO "MediaCleanupObligation_completedAt_nextAttemptAt_claimExpir_idx";

-- RenameIndex
ALTER INDEX "ProviderReceipt_platform_providerProcessingStatus_enrichedAt_en" RENAME TO "ProviderReceipt_platform_providerProcessingStatus_enrichedA_idx";

-- RenameIndex
ALTER INDEX "ReviewApprovalOverride_workspaceId_clientIdempotencyKey_exportI" RENAME TO "ReviewApprovalOverride_workspaceId_clientIdempotencyKey_exp_key";

-- RenameIndex
ALTER INDEX "ReviewNotificationLedger_reviewRoundId_recipientEmail_kind_scop" RENAME TO "ReviewNotificationLedger_reviewRoundId_recipientEmail_kind__key";

-- RenameIndex
ALTER INDEX "ReviewNotificationLedger_status_nextAttemptAt_leaseExpiresAt_id" RENAME TO "ReviewNotificationLedger_status_nextAttemptAt_leaseExpiresA_idx";

-- RenameIndex
ALTER INDEX "UploadSession_status_reconcileAt_reconciliationLeaseExpiresAt_i" RENAME TO "UploadSession_status_reconcileAt_reconciliationLeaseExpires_idx";

-- RenameIndex
ALTER INDEX "WorkflowEvent_notificationRequired_notificationDeliveredAt_next" RENAME TO "WorkflowEvent_notificationRequired_notificationDeliveredAt__idx";


COMMIT;
