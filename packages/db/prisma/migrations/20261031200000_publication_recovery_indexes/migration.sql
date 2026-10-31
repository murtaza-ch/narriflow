CREATE INDEX "SocialPost_recovery_cursor_idx" ON "SocialPost"("deploymentEpoch","createdAt","id")
  WHERE "status" IN ('preparing_video','scheduled','publishing','processing','reconciling');
CREATE INDEX "SocialPost_restore_cursor_idx" ON "SocialPost"("createdAt","id");
CREATE INDEX "StandingGrant_expiry_cursor_idx" ON "StandingGrant"("expiresAt","id") WHERE "status" IN ('active','paused');
CREATE INDEX "ProviderReceipt_recovery_cursor_idx" ON "ProviderReceipt"(
  COALESCE("enrichmentLeaseExpiresAt","enrichmentNextCheckAt","createdAt"),"id")
  WHERE "platform"='youtube_shorts' AND "providerProcessingStatus"='processing' AND "enrichedAt" IS NULL;
CREATE INDEX "PerformanceCapture_recovery_cursor_idx" ON "PerformanceCapture"(COALESCE("leaseExpiresAt","dueAt"),"id")
  WHERE "state"='scheduled';
CREATE INDEX "TrackedVideo_socialPostId_id_idx" ON "TrackedVideo"("socialPostId","id");
