-- Narriflow is pre-production. Incomplete and completed local Upload Session
-- rows use the retired Project-owned contract and are intentionally reset.
DROP TABLE "UploadSession";
DROP TYPE "UploadSessionStatus";

CREATE TYPE "UploadSessionStatus" AS ENUM (
  'initiating',
  'uploading',
  'finalizing',
  'reconciling',
  'compensating',
  'queued_for_ingest',
  'aborted',
  'expired',
  'failed'
);

CREATE TYPE "UploadTransferKind" AS ENUM ('single', 'multipart');

CREATE TABLE "UploadSession" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "legacyOwnerUserId" UUID NOT NULL,
  "clientIdempotencyKey" UUID NOT NULL,
  "immutableInputFingerprint" TEXT NOT NULL,
  "preallocatedProjectId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileSizeBytes" BIGINT NOT NULL,
  "contentType" TEXT NOT NULL,
  "browserFingerprint" TEXT NOT NULL,
  "brandTemplateId" UUID,
  "brandSnapshot" JSONB,
  "generationSettings" JSONB NOT NULL,
  "transferKind" "UploadTransferKind" NOT NULL,
  "partSizeBytes" INTEGER,
  "partCount" INTEGER NOT NULL DEFAULT 1,
  "storageKey" TEXT NOT NULL,
  "providerUploadId" TEXT,
  "providerInitiatedAt" TIMESTAMP(3),
  "status" "UploadSessionStatus" NOT NULL DEFAULT 'initiating',
  "admissionAttemptId" UUID,
  "admissionClaimExpiresAt" TIMESTAMP(3),
  "completionParts" JSONB,
  "verifiedSizeBytes" BIGINT,
  "verifiedContentType" TEXT,
  "queuedJobId" UUID,
  "failureCode" TEXT,
  "cleanupRetryAt" TIMESTAMP(3),
  "reconciliationAttemptId" UUID,
  "reconciliationLeaseExpiresAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "hardExpiresAt" TIMESTAMP(3) NOT NULL,
  "queuedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "IngestJob" ADD COLUMN "uploadSessionId" UUID;

CREATE UNIQUE INDEX "UploadSession_preallocatedProjectId_key"
  ON "UploadSession"("preallocatedProjectId");
CREATE UNIQUE INDEX "UploadSession_storageKey_key"
  ON "UploadSession"("storageKey");
CREATE UNIQUE INDEX "UploadSession_queuedJobId_key"
  ON "UploadSession"("queuedJobId");
CREATE UNIQUE INDEX "UploadSession_workspaceId_clientIdempotencyKey_key"
  ON "UploadSession"("workspaceId", "clientIdempotencyKey");
CREATE INDEX "UploadSession_workspaceId_status_createdAt_idx"
  ON "UploadSession"("workspaceId", "status", "createdAt");
CREATE INDEX "UploadSession_status_expiresAt_cleanupRetryAt_idx"
  ON "UploadSession"("status", "expiresAt", "cleanupRetryAt");
CREATE INDEX "UploadSession_status_admissionClaimExpiresAt_idx"
  ON "UploadSession"("status", "admissionClaimExpiresAt");
CREATE UNIQUE INDEX "IngestJob_uploadSessionId_key"
  ON "IngestJob"("uploadSessionId");

ALTER TABLE "UploadSession"
  ADD CONSTRAINT "UploadSession_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IngestJob"
  ADD CONSTRAINT "IngestJob_uploadSessionId_fkey"
  FOREIGN KEY ("uploadSessionId") REFERENCES "UploadSession"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
