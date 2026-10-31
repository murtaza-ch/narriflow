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

CREATE INDEX "StandingGrant_redispatch_cursor_idx" ON "StandingGrant"("createdAt","id") WHERE "status" IN ('active','paused');
CREATE INDEX "ProviderReceipt_redispatch_cursor_idx" ON "ProviderReceipt"("createdAt","id")
 WHERE "platform"='youtube_shorts' AND "providerProcessingStatus"='processing' AND "enrichedAt" IS NULL;
CREATE INDEX "PerformanceCapture_redispatch_cursor_idx" ON "PerformanceCapture"("createdAt","id") WHERE "state"='scheduled';

CREATE INDEX "ExecutionDispatch_guidance_restore_cursor_idx" ON "ExecutionDispatch"("deploymentEpoch","createdAt","id")
 WHERE "kind"='maintenance' AND "subjectKind"='maintenance' AND "subjectId" LIKE 'po1.g.%';
CREATE INDEX "ExecutionDispatch_guidance_chain_idx" ON "ExecutionDispatch"("deploymentEpoch",left("subjectId",42),"dueAt" DESC,"id" DESC)
 WHERE "kind"='maintenance' AND "subjectKind"='maintenance' AND "subjectId" LIKE 'po1.g.%';
