ALTER TYPE "VisualAssetProvenance" ADD VALUE 'extracted_frame';

ALTER TYPE "AnalyticsEventType" ADD VALUE 'assisted_copy_generated';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'assisted_copy_failed';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'assisted_copy_confirmed';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'assisted_copy_edited';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'thumbnail_prepared';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'thumbnail_failed';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'campaign_schedule_completed';

CREATE TYPE "AssistedCopyGenerationStatus" AS ENUM ('generating', 'completed', 'failed');
CREATE TYPE "ThumbnailFrameStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

CREATE TABLE "AssistedCopyGeneration" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "clipId" UUID NOT NULL,
  "createdByUserId" UUID NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "status" "AssistedCopyGenerationStatus" NOT NULL DEFAULT 'generating',
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "skippedGuidance" JSONB NOT NULL DEFAULT '[]',
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AssistedCopyGeneration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssistedCopyVariant" (
  "id" UUID NOT NULL,
  "generationId" UUID NOT NULL,
  "platform" "SocialPlatform" NOT NULL,
  "caption" TEXT NOT NULL,
  "hashtags" JSONB NOT NULL,
  "title" TEXT,
  "model" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "moderationOutcome" TEXT NOT NULL,
  "originalFingerprint" TEXT NOT NULL,
  "confirmationFingerprint" TEXT,
  "confirmedByUserId" UUID,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssistedCopyVariant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ThumbnailFrameOperation" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "clipId" UUID NOT NULL,
  "exportVariantId" UUID NOT NULL,
  "createdByUserId" UUID NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "exportFingerprint" TEXT NOT NULL,
  "sourceTimeMs" INTEGER NOT NULL,
  "status" "ThumbnailFrameStatus" NOT NULL DEFAULT 'queued',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "claimId" UUID,
  "claimExpiresAt" TIMESTAMP(3),
  "resultAssetId" UUID,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ThumbnailFrameOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ThumbnailFrameOperation_sourceTimeMs_check" CHECK ("sourceTimeMs" >= 0)
);

CREATE UNIQUE INDEX "AssistedCopyGeneration_workspaceId_idempotencyKey_key"
  ON "AssistedCopyGeneration"("workspaceId", "idempotencyKey");
CREATE INDEX "AssistedCopyGeneration_projectId_clipId_createdAt_idx"
  ON "AssistedCopyGeneration"("projectId", "clipId", "createdAt" DESC);
CREATE INDEX "AssistedCopyGeneration_status_createdAt_idx"
  ON "AssistedCopyGeneration"("status", "createdAt");
CREATE UNIQUE INDEX "AssistedCopyVariant_generationId_platform_key"
  ON "AssistedCopyVariant"("generationId", "platform");
CREATE INDEX "AssistedCopyVariant_confirmationFingerprint_idx"
  ON "AssistedCopyVariant"("confirmationFingerprint");
CREATE UNIQUE INDEX "ThumbnailFrameOperation_workspaceId_idempotencyKey_key"
  ON "ThumbnailFrameOperation"("workspaceId", "idempotencyKey");
CREATE UNIQUE INDEX "ThumbnailFrameOperation_exportVariantId_sourceTimeMs_key"
  ON "ThumbnailFrameOperation"("exportVariantId", "sourceTimeMs");
CREATE INDEX "ThumbnailFrameOperation_status_claimExpiresAt_createdAt_idx"
  ON "ThumbnailFrameOperation"("status", "claimExpiresAt", "createdAt");
CREATE INDEX "ThumbnailFrameOperation_projectId_clipId_createdAt_idx"
  ON "ThumbnailFrameOperation"("projectId", "clipId", "createdAt" DESC);
CREATE INDEX "ThumbnailFrameOperation_resultAssetId_idx"
  ON "ThumbnailFrameOperation"("resultAssetId");

ALTER TABLE "AssistedCopyGeneration"
  ADD CONSTRAINT "AssistedCopyGeneration_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistedCopyGeneration"
  ADD CONSTRAINT "AssistedCopyGeneration_clipId_fkey"
  FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistedCopyVariant"
  ADD CONSTRAINT "AssistedCopyVariant_generationId_fkey"
  FOREIGN KEY ("generationId") REFERENCES "AssistedCopyGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThumbnailFrameOperation"
  ADD CONSTRAINT "ThumbnailFrameOperation_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThumbnailFrameOperation"
  ADD CONSTRAINT "ThumbnailFrameOperation_clipId_fkey"
  FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThumbnailFrameOperation"
  ADD CONSTRAINT "ThumbnailFrameOperation_exportVariantId_fkey"
  FOREIGN KEY ("exportVariantId") REFERENCES "ClipExportVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThumbnailFrameOperation"
  ADD CONSTRAINT "ThumbnailFrameOperation_resultAssetId_fkey"
  FOREIGN KEY ("resultAssetId") REFERENCES "VisualAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
