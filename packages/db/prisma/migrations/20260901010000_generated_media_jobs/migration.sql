CREATE TYPE "GeneratedMediaJobStatus" AS ENUM ('queued', 'running', 'waiting', 'completed', 'failed', 'rejected', 'cancelled');
CREATE TYPE "GeneratedMediaUsageStatus" AS ENUM ('reserved', 'finalized', 'released');
CREATE TYPE "GeneratedMediaPromptOrigin" AS ENUM ('transcript_selection', 'broll_cue', 'manual');

CREATE TABLE "GeneratedMediaJob" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "clipId" UUID,
  "createdByUserId" UUID NOT NULL,
  "workspaceOwnerUserId" UUID NOT NULL,
  "actorRole" TEXT NOT NULL,
  "actorStatus" TEXT NOT NULL,
  "pricingTier" TEXT NOT NULL,
  "isPersonalWorkspace" BOOLEAN NOT NULL,
  "mediaKind" TEXT NOT NULL DEFAULT 'image',
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "protectedPrompt" TEXT NOT NULL,
  "promptFingerprint" TEXT NOT NULL,
  "promptOrigin" "GeneratedMediaPromptOrigin" NOT NULL,
  "sourceStartSec" DOUBLE PRECISION,
  "sourceEndSec" DOUBLE PRECISION,
  "sourceCueAtSec" DOUBLE PRECISION,
  "aspectRatio" TEXT NOT NULL,
  "style" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" "GeneratedMediaJobStatus" NOT NULL DEFAULT 'queued',
  "moderationStatus" TEXT NOT NULL DEFAULT 'pending',
  "usageStatus" "GeneratedMediaUsageStatus" NOT NULL DEFAULT 'reserved',
  "usageReservationId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerModel" TEXT NOT NULL,
  "providerRef" TEXT,
  "providerUsageImages" INTEGER,
  "resultAssetId" UUID,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "retryAt" TIMESTAMP(3),
  "claimId" UUID,
  "claimExpiresAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "outcomeUnknown" BOOLEAN NOT NULL DEFAULT false,
  "insertedAt" TIMESTAMP(3),
  "brandSavedAt" TIMESTAMP(3),
  "promptExpiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GeneratedMediaJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GeneratedMediaJob_usageReservationId_key" ON "GeneratedMediaJob"("usageReservationId");
CREATE UNIQUE INDEX "GeneratedMediaJob_workspaceId_idempotencyKey_key" ON "GeneratedMediaJob"("workspaceId", "idempotencyKey");
CREATE INDEX "GeneratedMediaJob_status_retryAt_claimExpiresAt_createdAt_idx" ON "GeneratedMediaJob"("status", "retryAt", "claimExpiresAt", "createdAt");
CREATE INDEX "GeneratedMediaJob_workspaceId_createdAt_idx" ON "GeneratedMediaJob"("workspaceId", "createdAt");
CREATE INDEX "GeneratedMediaJob_projectId_clipId_createdAt_idx" ON "GeneratedMediaJob"("projectId", "clipId", "createdAt");
CREATE INDEX "GeneratedMediaJob_resultAssetId_idx" ON "GeneratedMediaJob"("resultAssetId");
CREATE INDEX "GeneratedMediaJob_promptExpiresAt_idx" ON "GeneratedMediaJob"("promptExpiresAt");

ALTER TABLE "GeneratedMediaJob" ADD CONSTRAINT "GeneratedMediaJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaJob" ADD CONSTRAINT "GeneratedMediaJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaJob" ADD CONSTRAINT "GeneratedMediaJob_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaJob" ADD CONSTRAINT "GeneratedMediaJob_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaJob" ADD CONSTRAINT "GeneratedMediaJob_resultAssetId_fkey" FOREIGN KEY ("resultAssetId") REFERENCES "VisualAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "GeneratedMediaUsageReservation" (
  "id" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "policy" TEXT NOT NULL,
  "status" "GeneratedMediaUsageStatus" NOT NULL DEFAULT 'reserved',
  "reservedUnits" INTEGER NOT NULL DEFAULT 1,
  "actualUnits" INTEGER,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "GeneratedMediaUsageReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GeneratedMediaUsageReservation_jobId_key" ON "GeneratedMediaUsageReservation"("jobId");
CREATE INDEX "GeneratedMediaUsageReservation_workspaceId_status_createdAt_idx" ON "GeneratedMediaUsageReservation"("workspaceId", "status", "createdAt");
CREATE INDEX "GeneratedMediaUsageReservation_actorUserId_createdAt_idx" ON "GeneratedMediaUsageReservation"("actorUserId", "createdAt");
ALTER TABLE "GeneratedMediaUsageReservation" ADD CONSTRAINT "GeneratedMediaUsageReservation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaUsageReservation" ADD CONSTRAINT "GeneratedMediaUsageReservation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
