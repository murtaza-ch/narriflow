CREATE TABLE "ReviewApprovalOverride" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "exportId" UUID NOT NULL,
  "reviewRoundId" UUID,
  "actorUserId" UUID NOT NULL,
  "clientIdempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewApprovalOverride_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReviewApprovalOverride_reason_check"
    CHECK (char_length(btrim("reason")) BETWEEN 1 AND 500)
);

ALTER TABLE "SocialPost"
  ADD COLUMN "reviewApprovalOverrideId" UUID;

ALTER TABLE "CampaignOperationItem"
  ADD COLUMN "reviewApprovalOverrideId" UUID;

CREATE UNIQUE INDEX "ReviewApprovalOverride_workspaceId_clientIdempotencyKey_exportId_key"
  ON "ReviewApprovalOverride"("workspaceId", "clientIdempotencyKey", "exportId");
CREATE INDEX "ReviewApprovalOverride_projectId_createdAt_idx"
  ON "ReviewApprovalOverride"("projectId", "createdAt" DESC);
CREATE INDEX "ReviewApprovalOverride_exportId_idx"
  ON "ReviewApprovalOverride"("exportId");
CREATE INDEX "ReviewApprovalOverride_reviewRoundId_idx"
  ON "ReviewApprovalOverride"("reviewRoundId");
CREATE INDEX "SocialPost_reviewApprovalOverrideId_idx"
  ON "SocialPost"("reviewApprovalOverrideId");
CREATE INDEX "CampaignOperationItem_reviewApprovalOverrideId_idx"
  ON "CampaignOperationItem"("reviewApprovalOverrideId");

ALTER TABLE "ReviewApprovalOverride"
  ADD CONSTRAINT "ReviewApprovalOverride_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE;
ALTER TABLE "ReviewApprovalOverride"
  ADD CONSTRAINT "ReviewApprovalOverride_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE;
ALTER TABLE "ReviewApprovalOverride"
  ADD CONSTRAINT "ReviewApprovalOverride_exportId_fkey"
  FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id") ON DELETE RESTRICT;
ALTER TABLE "ReviewApprovalOverride"
  ADD CONSTRAINT "ReviewApprovalOverride_reviewRoundId_fkey"
  FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE SET NULL;
ALTER TABLE "SocialPost"
  ADD CONSTRAINT "SocialPost_reviewApprovalOverrideId_fkey"
  FOREIGN KEY ("reviewApprovalOverrideId") REFERENCES "ReviewApprovalOverride"("id") ON DELETE SET NULL;
ALTER TABLE "CampaignOperationItem"
  ADD CONSTRAINT "CampaignOperationItem_reviewApprovalOverrideId_fkey"
  FOREIGN KEY ("reviewApprovalOverrideId") REFERENCES "ReviewApprovalOverride"("id") ON DELETE SET NULL;
