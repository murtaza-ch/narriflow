ALTER TABLE "ReviewRound"
ADD COLUMN "previousRoundId" UUID;

CREATE UNIQUE INDEX "ReviewRound_previousRoundId_key"
ON "ReviewRound"("previousRoundId");

ALTER TABLE "ReviewRound"
ADD CONSTRAINT "ReviewRound_previousRoundId_fkey"
FOREIGN KEY ("previousRoundId") REFERENCES "ReviewRound"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReviewRecipient" (
  "id" UUID NOT NULL,
  "reviewRoundId" UUID NOT NULL,
  "role" TEXT NOT NULL,
  "emailHash" TEXT NOT NULL,
  "emailEncrypted" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewRecipient_reviewRoundId_role_emailHash_key"
ON "ReviewRecipient"("reviewRoundId", "role", "emailHash");
CREATE INDEX "ReviewRecipient_reviewRoundId_role_idx"
ON "ReviewRecipient"("reviewRoundId", "role");

ALTER TABLE "ReviewRecipient"
ADD CONSTRAINT "ReviewRecipient_reviewRoundId_fkey"
FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReviewNotification" (
  "id" UUID NOT NULL,
  "reviewRoundId" UUID NOT NULL,
  "recipientId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimId" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "failureCode" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewNotification_claimId_key"
ON "ReviewNotification"("claimId");
CREATE UNIQUE INDEX "ReviewNotification_round_recipient_kind_source_key"
ON "ReviewNotification"("reviewRoundId", "recipientId", "kind", "sourceKey");
CREATE INDEX "ReviewNotification_status_due_lease_idx"
ON "ReviewNotification"("status", "nextAttemptAt", "leaseExpiresAt");
CREATE INDEX "ReviewNotification_round_created_idx"
ON "ReviewNotification"("reviewRoundId", "createdAt");

ALTER TABLE "ReviewNotification"
ADD CONSTRAINT "ReviewNotification_reviewRoundId_fkey"
FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewNotification"
ADD CONSTRAINT "ReviewNotification_recipientId_fkey"
FOREIGN KEY ("recipientId") REFERENCES "ReviewRecipient"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReviewApprovalOverride" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "exportIds" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewApprovalOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewApprovalOverride_workspaceId_idempotencyKey_key"
ON "ReviewApprovalOverride"("workspaceId", "idempotencyKey");
CREATE INDEX "ReviewApprovalOverride_projectId_createdAt_idx"
ON "ReviewApprovalOverride"("projectId", "createdAt");
CREATE INDEX "ReviewApprovalOverride_actorUserId_createdAt_idx"
ON "ReviewApprovalOverride"("actorUserId", "createdAt");

ALTER TABLE "ReviewApprovalOverride"
ADD CONSTRAINT "ReviewApprovalOverride_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewApprovalOverride"
ADD CONSTRAINT "ReviewApprovalOverride_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewApprovalOverride"
ADD CONSTRAINT "ReviewApprovalOverride_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SocialPost"
ADD COLUMN "reviewApprovalOverrideId" UUID;
CREATE INDEX "SocialPost_reviewApprovalOverrideId_idx"
ON "SocialPost"("reviewApprovalOverrideId");
ALTER TABLE "SocialPost"
ADD CONSTRAINT "SocialPost_reviewApprovalOverrideId_fkey"
FOREIGN KEY ("reviewApprovalOverrideId") REFERENCES "ReviewApprovalOverride"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CampaignOperationItem"
ADD COLUMN "reviewApprovalOverrideId" UUID;
CREATE INDEX "CampaignOperationItem_reviewApprovalOverrideId_idx"
ON "CampaignOperationItem"("reviewApprovalOverrideId");
ALTER TABLE "CampaignOperationItem"
ADD CONSTRAINT "CampaignOperationItem_reviewApprovalOverrideId_fkey"
FOREIGN KEY ("reviewApprovalOverrideId") REFERENCES "ReviewApprovalOverride"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
