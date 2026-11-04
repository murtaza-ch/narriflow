-- DropForeignKey
ALTER TABLE "FrozenPublicationState" DROP CONSTRAINT "FrozenPublicationState_clipExportId_fkey";

-- DropForeignKey
ALTER TABLE "FrozenPublicationState" DROP CONSTRAINT "FrozenPublicationState_clipExportVariantId_fkey";

-- DropForeignKey
ALTER TABLE "ProviderReceipt" DROP CONSTRAINT "ProviderReceipt_attemptId_fkey";

-- DropForeignKey
ALTER TABLE "PublicationAnalyticsIntent" DROP CONSTRAINT "PublicationAnalyticsIntent_attemptId_fkey";

-- DropForeignKey
ALTER TABLE "PublicationManualDecision" DROP CONSTRAINT "PublicationManualDecision_attemptId_fkey";

-- DropForeignKey
ALTER TABLE "PublicationManualDecision" DROP CONSTRAINT "PublicationManualDecision_socialPostId_fkey";

-- DropForeignKey
ALTER TABLE "PublicationManualDecision" DROP CONSTRAINT "PublicationManualDecision_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "RenderGroup" DROP CONSTRAINT "RenderGroup_preparationId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewApprovalOverride" DROP CONSTRAINT "ReviewApprovalOverride_exportId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewRoundContext" DROP CONSTRAINT "ReviewRoundContext_sourceCommentId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewRoundItem" DROP CONSTRAINT "ReviewRoundItem_clipId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewRoundItem" DROP CONSTRAINT "ReviewRoundItem_exportId_fkey";

-- DropForeignKey
ALTER TABLE "SocialPublicationAttempt" DROP CONSTRAINT "SocialPublicationAttempt_frozenStateId_fkey";

-- DropForeignKey
ALTER TABLE "SocialPublicationAttempt" DROP CONSTRAINT "SocialPublicationAttempt_priorAttemptId_fkey";

-- DropForeignKey
ALTER TABLE "Transcript" DROP CONSTRAINT "Transcript_sourceAudioId_projectId_sourceRevision_fkey";

-- DropIndex
DROP INDEX "Clip_autoLayoutStatus_autoLayoutLeaseExpiresAt_idx";

-- DropIndex
DROP INDEX "ClipRender_clipId_idx";

-- DropIndex
DROP INDEX "CompletionCallback_state_nextObservationAt_idx";

-- DropIndex
DROP INDEX "FrozenPublicationState_clipExportVariantId_idx";

-- DropIndex
DROP INDEX "ProjectDeletionReceipt_deleteAfter_idx";

-- DropIndex
DROP INDEX "SocialPost_socialAccountId_idx";

-- DropIndex
DROP INDEX "TrackedVideo_socialPostId_idx";

-- DropIndex
DROP INDEX "User_clerkId_idx";

-- DropIndex
DROP INDEX "WorkflowEvent_nextDeliveryAt_deliveryLeaseExpiresAt_idx";

-- DropIndex
DROP INDEX "WorkflowEvent_notificationRequired_notificationDeliveredAt__idx";

-- DropIndex
DROP INDEX "WorkflowEvent_projectId_seq_idx";

-- DropIndex
DROP INDEX "WorkspaceEvent_createdAt_idx";

-- AlterTable
ALTER TABLE "Clip" DROP COLUMN "autoLayoutAttemptCount",
DROP COLUMN "autoLayoutClaimToken",
DROP COLUMN "autoLayoutLeaseExpiresAt";

-- AlterTable
ALTER TABLE "CompletionCallback" DROP COLUMN "nextObservationAt";

-- AlterTable
ALTER TABLE "WorkflowEvent" DROP COLUMN "analyticsPublishedAt",
DROP COLUMN "analyticsRequired",
DROP COLUMN "availableAt",
DROP COLUMN "deadLetteredAt",
DROP COLUMN "deliveryAttempts",
DROP COLUMN "deliveryLeaseExpiresAt",
DROP COLUMN "deliveryLeaseOwner",
DROP COLUMN "lastDeliveryError",
DROP COLUMN "nextDeliveryAt";

-- CreateIndex
CREATE INDEX "AssistedCopyGeneration_clipId_idx" ON "AssistedCopyGeneration"("clipId");

-- CreateIndex
CREATE INDEX "CompletionCallback_updatedAt_id_idx" ON "CompletionCallback"("updatedAt", "id");

-- CreateIndex
CREATE INDEX "ContentPack_projectId_createdAt_id_idx" ON "ContentPack"("projectId", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "GeneratedMediaJob_clipId_idx" ON "GeneratedMediaJob"("clipId");

-- CreateIndex
CREATE INDEX "IngestJob_generationRunId_idx" ON "IngestJob"("generationRunId");

-- CreateIndex
CREATE INDEX "ReviewComment_itemId_idx" ON "ReviewComment"("itemId");

-- CreateIndex
CREATE INDEX "ReviewDecision_itemId_idx" ON "ReviewDecision"("itemId");

-- CreateIndex
CREATE INDEX "ReviewRoundItem_clipId_idx" ON "ReviewRoundItem"("clipId");

-- CreateIndex
CREATE INDEX "SocialPublicationAttempt_frozenStateId_idx" ON "SocialPublicationAttempt"("frozenStateId");

-- CreateIndex
CREATE INDEX "SocialPublicationAttempt_priorAttemptId_idx" ON "SocialPublicationAttempt"("priorAttemptId");

-- CreateIndex
CREATE INDEX "ThumbnailFrameOperation_clipId_idx" ON "ThumbnailFrameOperation"("clipId");

-- CreateIndex
CREATE INDEX "WorkflowRun_contentPackId_idx" ON "WorkflowRun"("contentPackId");

-- AddForeignKey
ALTER TABLE "RenderGroup" ADD CONSTRAINT "RenderGroup_preparationId_fkey" FOREIGN KEY ("preparationId") REFERENCES "ClipPreparation"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_sourceAudioId_projectId_sourceRevision_fkey" FOREIGN KEY ("sourceAudioId", "projectId", "sourceRevision") REFERENCES "SourceAudio"("id", "projectId", "sourceRevision") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRoundContext" ADD CONSTRAINT "ReviewRoundContext_sourceCommentId_fkey" FOREIGN KEY ("sourceCommentId") REFERENCES "ReviewComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRoundItem" ADD CONSTRAINT "ReviewRoundItem_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRoundItem" ADD CONSTRAINT "ReviewRoundItem_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewApprovalOverride" ADD CONSTRAINT "ReviewApprovalOverride_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrozenPublicationState" ADD CONSTRAINT "FrozenPublicationState_clipExportId_fkey" FOREIGN KEY ("clipExportId") REFERENCES "ClipExport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrozenPublicationState" ADD CONSTRAINT "FrozenPublicationState_clipExportVariantId_fkey" FOREIGN KEY ("clipExportVariantId") REFERENCES "ClipExportVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublicationAttempt" ADD CONSTRAINT "SocialPublicationAttempt_frozenStateId_fkey" FOREIGN KEY ("frozenStateId") REFERENCES "FrozenPublicationState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublicationAttempt" ADD CONSTRAINT "SocialPublicationAttempt_priorAttemptId_fkey" FOREIGN KEY ("priorAttemptId") REFERENCES "SocialPublicationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationManualDecision" ADD CONSTRAINT "PublicationManualDecision_socialPostId_fkey" FOREIGN KEY ("socialPostId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationManualDecision" ADD CONSTRAINT "PublicationManualDecision_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "SocialPublicationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationManualDecision" ADD CONSTRAINT "PublicationManualDecision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReceipt" ADD CONSTRAINT "ProviderReceipt_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "SocialPublicationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationAnalyticsIntent" ADD CONSTRAINT "PublicationAnalyticsIntent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "SocialPublicationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pending invites: one per Workspace and case-folded email. Keep the newest.
UPDATE "WorkspaceInvite" SET "revokedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY "workspaceId", lower(email) ORDER BY "createdAt" DESC, id DESC) AS position
    FROM "WorkspaceInvite" WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL
  ) ranked WHERE position > 1
);
CREATE UNIQUE INDEX "WorkspaceInvite_pending_email_key" ON "WorkspaceInvite"("workspaceId", lower(email))
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

-- Daily ledger retention reads these tables by age.
CREATE INDEX "OperationReceipt_createdAt_id_idx" ON "OperationReceipt"("createdAt", "id");
CREATE INDEX "ProgramAnalyticsEvent_createdAt_id_idx" ON "ProgramAnalyticsEvent"("createdAt", "id");
CREATE INDEX "OutboundDelivery_status_expiresAt_idx" ON "OutboundDelivery"("status", "expiresAt");
CREATE INDEX "MediaCleanupObligation_objectKey_idx" ON "MediaCleanupObligation"("objectKey");

-- Lifecycle vocabularies, taken from the code that writes each column.
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_status_check"
  CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'partial', 'failed', 'cancelled'));
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_stage_check"
  CHECK (stage IN ('ingest', 'ingest_queued', 'ingest_downloading', 'ingest_normalizing', 'ingest_retrying', 'ingest_ready', 'stt', 'moment_detection', 'clip_rendering', 'dubbing', 'output_pack_generation', 'export_bundle'));
ALTER TABLE "ReviewRound" ADD CONSTRAINT "ReviewRound_status_check"
  CHECK (status IN ('open', 'superseded', 'revoked'));
ALTER TABLE "GenerationFinishing" ADD CONSTRAINT "GenerationFinishing_state_check"
  CHECK (state IN ('waiting', 'due', 'running', 'exporting', 'ready', 'partial', 'skipped'));
ALTER TABLE "CampaignOperation" ADD CONSTRAINT "CampaignOperation_status_check"
  CHECK (status IN ('running', 'completed', 'partial', 'failed'));
ALTER TABLE "NotificationLedger" ADD CONSTRAINT "NotificationLedger_status_check"
  CHECK (status IN ('pending', 'claimed', 'sent', 'failed', 'skipped'));
