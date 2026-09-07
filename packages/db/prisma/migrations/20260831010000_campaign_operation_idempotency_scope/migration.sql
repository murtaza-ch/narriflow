DROP INDEX "CampaignOperation_workspaceId_idempotencyKey_key";

CREATE UNIQUE INDEX "CampaignOperation_workspaceId_projectId_action_idempotencyKey_key"
ON "CampaignOperation"("workspaceId", "projectId", "action", "idempotencyKey");

ALTER TABLE "CampaignOperation"
ADD COLUMN "claimToken" UUID,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
