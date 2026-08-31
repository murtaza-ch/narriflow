ALTER TYPE "VisualAssetProvenance" ADD VALUE IF NOT EXISTS 'extracted';

ALTER TABLE "VisualAsset"
  ADD COLUMN "hasAudio" BOOLEAN,
  ADD COLUMN "videoCodec" TEXT,
  ADD COLUMN "audioCodec" TEXT,
  ADD COLUMN "sourceExportVariantId" UUID,
  ADD COLUMN "sourceTimeMs" INTEGER;

ALTER TABLE "VisualAsset"
  ADD CONSTRAINT "VisualAsset_source_export_identity_check"
  CHECK (
    ("sourceExportVariantId" IS NULL AND "sourceTimeMs" IS NULL)
    OR
    ("sourceExportVariantId" IS NOT NULL AND "sourceTimeMs" IS NOT NULL AND "sourceTimeMs" >= 0)
  );

CREATE UNIQUE INDEX "VisualAsset_sourceExportVariantId_sourceTimeMs_key"
  ON "VisualAsset"("sourceExportVariantId", "sourceTimeMs");
CREATE INDEX "VisualAsset_sourceExportVariantId_idx"
  ON "VisualAsset"("sourceExportVariantId");

ALTER TABLE "VisualAsset"
  ADD CONSTRAINT "VisualAsset_sourceExportVariantId_fkey"
  FOREIGN KEY ("sourceExportVariantId") REFERENCES "ClipExportVariant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "GeneratedMediaJob" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "clipId" UUID,
  "actorUserId" UUID NOT NULL,
  "ownerUserId" UUID,
  "ownerWorkspaceId" UUID,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "idempotencyKey" UUID NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptCiphertext" TEXT,
  "promptFingerprint" TEXT NOT NULL,
  "promptDeleteAfter" TIMESTAMP(3),
  "promptOriginKind" TEXT NOT NULL,
  "promptOriginSourceIds" JSONB NOT NULL,
  "aspectRatio" TEXT NOT NULL,
  "style" TEXT NOT NULL,
  "durationSec" DOUBLE PRECISION,
  "seed" INTEGER,
  "title" TEXT,
  "providerReference" TEXT,
  "resultReference" TEXT,
  "providerUsageUnits" INTEGER,
  "moderationOutcome" TEXT NOT NULL DEFAULT 'pending',
  "moderationStage" TEXT,
  "moderationCategories" JSONB,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "claimId" UUID,
  "claimOwner" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "submissionStartedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextPollAt" TIMESTAMP(3),
  "cancelRequestedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "stagedStorageKey" TEXT,
  "stagedContentType" TEXT,
  "stagedSizeBytes" BIGINT,
  "stagedWidth" INTEGER,
  "stagedHeight" INTEGER,
  "stagedDurationSec" DOUBLE PRECISION,
  "stagedHasAudio" BOOLEAN,
  "stagedVideoCodec" TEXT,
  "stagedAudioCodec" TEXT,
  "stagedFingerprint" TEXT,
  "resultAssetId" UUID,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GeneratedMediaJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GeneratedMediaJob_owner_check" CHECK (
    ("ownerUserId" IS NOT NULL AND "ownerWorkspaceId" IS NULL)
    OR
    ("ownerUserId" IS NULL AND "ownerWorkspaceId" IS NOT NULL)
  ),
  CONSTRAINT "GeneratedMediaJob_kind_check" CHECK ("kind" IN ('image', 'video')),
  CONSTRAINT "GeneratedMediaJob_status_check" CHECK (
    "status" IN ('queued', 'running', 'waiting', 'completed', 'failed', 'rejected', 'cancelled')
  ),
  CONSTRAINT "GeneratedMediaJob_prompt_origin_check" CHECK (
    "promptOriginKind" IN ('manual', 'transcript_selection', 'broll_cue')
  ),
  CONSTRAINT "GeneratedMediaJob_moderation_check" CHECK (
    "moderationOutcome" IN ('pending', 'passed', 'rejected')
  ),
  CONSTRAINT "GeneratedMediaJob_attempt_count_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "GeneratedMediaJob_usage_units_check" CHECK (
    "providerUsageUnits" IS NULL OR "providerUsageUnits" >= 0
  ),
  CONSTRAINT "GeneratedMediaJob_duration_check" CHECK (
    ("kind" = 'image' AND "durationSec" IS NULL)
    OR
    ("kind" = 'video' AND "durationSec" > 0)
  ),
  CONSTRAINT "GeneratedMediaJob_claim_check" CHECK (
    ("claimId" IS NULL AND "claimOwner" IS NULL AND "claimExpiresAt" IS NULL)
    OR
    ("claimId" IS NOT NULL AND "claimOwner" IS NOT NULL AND "claimExpiresAt" IS NOT NULL)
  )
);

CREATE TABLE "GenerationUsageReservation" (
  "id" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "reservedUnits" INTEGER NOT NULL,
  "finalizedUnits" INTEGER NOT NULL DEFAULT 0,
  "releasedUnits" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'reserved',
  "finalizedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GenerationUsageReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GenerationUsageReservation_kind_check" CHECK ("kind" IN ('image', 'video')),
  CONSTRAINT "GenerationUsageReservation_status_check" CHECK (
    "status" IN ('reserved', 'finalized', 'released')
  ),
  CONSTRAINT "GenerationUsageReservation_units_check" CHECK (
    "reservedUnits" > 0
    AND "finalizedUnits" >= 0
    AND "releasedUnits" >= 0
    AND "finalizedUnits" <= "reservedUnits"
    AND "releasedUnits" <= "reservedUnits"
    AND NOT ("finalizedUnits" > 0 AND "releasedUnits" > 0)
  )
);

CREATE UNIQUE INDEX "GeneratedMediaJob_workspaceId_idempotencyKey_key"
  ON "GeneratedMediaJob"("workspaceId", "idempotencyKey");
CREATE UNIQUE INDEX "GeneratedMediaJob_claimId_key" ON "GeneratedMediaJob"("claimId");
CREATE UNIQUE INDEX "GeneratedMediaJob_stagedStorageKey_key" ON "GeneratedMediaJob"("stagedStorageKey");
CREATE UNIQUE INDEX "GeneratedMediaJob_resultAssetId_key" ON "GeneratedMediaJob"("resultAssetId");
CREATE INDEX "GeneratedMediaJob_workspaceId_projectId_createdAt_idx"
  ON "GeneratedMediaJob"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "GeneratedMediaJob_status_nextAttemptAt_claimExpiresAt_createdAt_idx"
  ON "GeneratedMediaJob"("status", "nextAttemptAt", "claimExpiresAt", "createdAt");
CREATE INDEX "GeneratedMediaJob_status_nextPollAt_idx"
  ON "GeneratedMediaJob"("status", "nextPollAt");
CREATE INDEX "GeneratedMediaJob_provider_kind_status_idx"
  ON "GeneratedMediaJob"("provider", "kind", "status");
CREATE INDEX "GeneratedMediaJob_promptDeleteAfter_idx"
  ON "GeneratedMediaJob"("promptDeleteAfter");

CREATE UNIQUE INDEX "GenerationUsageReservation_jobId_key"
  ON "GenerationUsageReservation"("jobId");
CREATE INDEX "GenerationUsageReservation_workspaceId_kind_status_idx"
  ON "GenerationUsageReservation"("workspaceId", "kind", "status");
CREATE INDEX "GenerationUsageReservation_status_updatedAt_idx"
  ON "GenerationUsageReservation"("status", "updatedAt");

ALTER TABLE "GeneratedMediaJob"
  ADD CONSTRAINT "GeneratedMediaJob_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaJob"
  ADD CONSTRAINT "GeneratedMediaJob_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaJob"
  ADD CONSTRAINT "GeneratedMediaJob_clipId_fkey"
  FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaJob"
  ADD CONSTRAINT "GeneratedMediaJob_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaJob"
  ADD CONSTRAINT "GeneratedMediaJob_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaJob"
  ADD CONSTRAINT "GeneratedMediaJob_ownerWorkspaceId_fkey"
  FOREIGN KEY ("ownerWorkspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeneratedMediaJob"
  ADD CONSTRAINT "GeneratedMediaJob_resultAssetId_fkey"
  FOREIGN KEY ("resultAssetId") REFERENCES "VisualAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GenerationUsageReservation"
  ADD CONSTRAINT "GenerationUsageReservation_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "GeneratedMediaJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GenerationUsageReservation"
  ADD CONSTRAINT "GenerationUsageReservation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
