-- Free-project retention is opt-in at the application activation timestamp;
-- existing rows remain NULL and are therefore grandfathered.
ALTER TYPE "IngestJobStatus" ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TABLE "Project"
  ADD COLUMN "retentionPolicyKey" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "purgeStartedAt" TIMESTAMP(3),
  ADD COLUMN "purgeLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "purgeRetryAt" TIMESTAMP(3),
  ADD COLUMN "purgeAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "purgeDeletedObjectCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "purgeDeletedBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "purgeStorageVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "purgeLastError" TEXT;

ALTER TABLE "User"
  ADD COLUMN "billingEventCreatedAt" TIMESTAMP(3);

CREATE INDEX "Project_expiresAt_purgeRetryAt_purgeLeaseExpiresAt_idx"
  ON "Project"("expiresAt", "purgeRetryAt", "purgeLeaseExpiresAt");

CREATE TABLE "ProjectDeletionReceipt" (
  "id" UUID NOT NULL,
  "projectIdHash" TEXT NOT NULL,
  "retentionPolicyKey" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "purgeCompletedAt" TIMESTAMP(3) NOT NULL,
  "objectCount" INTEGER NOT NULL,
  "totalBytes" BIGINT NOT NULL,
  "tombstoneStorageKey" TEXT NOT NULL,
  "deleteAfter" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectDeletionReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectDeletionReceipt_projectIdHash_key"
  ON "ProjectDeletionReceipt"("projectIdHash");
CREATE INDEX "ProjectDeletionReceipt_deleteAfter_idx"
  ON "ProjectDeletionReceipt"("deleteAfter");
