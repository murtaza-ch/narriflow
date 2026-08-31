ALTER TABLE "GeneratedMediaJob"
  ADD COLUMN "insertionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastInsertionKind" TEXT,
  ADD COLUMN "lastInsertedAt" TIMESTAMP(3);

ALTER TABLE "GeneratedMediaJob"
  ADD CONSTRAINT "GeneratedMediaJob_insertion_count_check"
  CHECK ("insertionCount" >= 0),
  ADD CONSTRAINT "GeneratedMediaJob_insertion_audit_check"
  CHECK (
    ("insertionCount" = 0 AND "lastInsertionKind" IS NULL AND "lastInsertedAt" IS NULL)
    OR
    ("insertionCount" > 0 AND "lastInsertionKind" IN ('broll', 'scene_block') AND "lastInsertedAt" IS NOT NULL)
  );

ALTER TABLE "CampaignOperationItem" ADD COLUMN "itemKey" TEXT;
UPDATE "CampaignOperationItem" SET "itemKey" = "requestedClipId"::TEXT;
ALTER TABLE "CampaignOperationItem" ALTER COLUMN "itemKey" SET NOT NULL;
DROP INDEX "CampaignOperationItem_operationId_requestedClipId_key";
CREATE UNIQUE INDEX "CampaignOperationItem_operationId_itemKey_key"
  ON "CampaignOperationItem"("operationId", "itemKey");

CREATE TABLE "AssistedCopyDraft" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "clipId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "sourceDraftId" UUID,
  "idempotencyKey" UUID NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "platform" "SocialPlatform" NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'generating',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "content" JSONB,
  "confirmedAt" TIMESTAMP(3),
  "modelAlias" TEXT,
  "promptVersion" TEXT NOT NULL,
  "moderationOutcome" TEXT NOT NULL DEFAULT 'pending',
  "errorCode" TEXT,
  "brandProfileId" UUID,
  "brandProfileRevision" INTEGER,
  "guidanceSkipped" BOOLEAN NOT NULL DEFAULT false,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "generationDeadline" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AssistedCopyDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistedCopyDraft_status_check" CHECK (
    "status" IN ('generating', 'completed', 'rejected', 'failed', 'unknown')
  ),
  CONSTRAINT "AssistedCopyDraft_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "AssistedCopyDraft_moderation_check" CHECK (
    "moderationOutcome" IN ('pending', 'accepted', 'rejected', 'unknown')
  ),
  CONSTRAINT "AssistedCopyDraft_token_usage_check" CHECK (
    ("inputTokens" IS NULL OR "inputTokens" >= 0)
    AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
  ),
  CONSTRAINT "AssistedCopyDraft_profile_revision_check" CHECK (
    ("brandProfileId" IS NULL AND "brandProfileRevision" IS NULL)
    OR ("brandProfileId" IS NOT NULL AND "brandProfileRevision" IS NOT NULL AND "brandProfileRevision" > 0)
  ),
  CONSTRAINT "AssistedCopyDraft_confirmation_check" CHECK (
    "confirmedAt" IS NULL OR ("status" = 'completed' AND "content" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "AssistedCopyDraft_workspaceId_idempotencyKey_key"
  ON "AssistedCopyDraft"("workspaceId", "idempotencyKey");
CREATE INDEX "AssistedCopyDraft_workspaceId_projectId_createdAt_idx"
  ON "AssistedCopyDraft"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "AssistedCopyDraft_clipId_platform_createdAt_idx"
  ON "AssistedCopyDraft"("clipId", "platform", "createdAt" DESC);
CREATE INDEX "AssistedCopyDraft_status_generationDeadline_idx"
  ON "AssistedCopyDraft"("status", "generationDeadline");
CREATE INDEX "AssistedCopyDraft_sourceDraftId_idx"
  ON "AssistedCopyDraft"("sourceDraftId");

CREATE TABLE "ThumbnailExtractionJob" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "platform" "SocialPlatform" NOT NULL,
  "exportVariantId" UUID NOT NULL,
  "sourceStorageKey" TEXT NOT NULL,
  "sourceTimeMs" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimId" UUID,
  "claimExpiresAt" TIMESTAMP(3),
  "assetId" UUID,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ThumbnailExtractionJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ThumbnailExtractionJob_status_check" CHECK (
    "status" IN ('queued', 'processing', 'completed', 'failed')
  ),
  CONSTRAINT "ThumbnailExtractionJob_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 3),
  CONSTRAINT "ThumbnailExtractionJob_time_check" CHECK ("sourceTimeMs" >= 0),
  CONSTRAINT "ThumbnailExtractionJob_claim_check" CHECK (
    ("claimId" IS NULL AND "claimExpiresAt" IS NULL)
    OR ("claimId" IS NOT NULL AND "claimExpiresAt" IS NOT NULL AND "status" = 'processing')
  )
);

CREATE UNIQUE INDEX "ThumbnailExtractionJob_claimId_key"
  ON "ThumbnailExtractionJob"("claimId");
CREATE INDEX "ThumbnailExtractionJob_assetId_idx"
  ON "ThumbnailExtractionJob"("assetId");
CREATE UNIQUE INDEX "ThumbnailExtractionJob_workspaceId_projectId_idempotencyKey_key"
  ON "ThumbnailExtractionJob"("workspaceId", "projectId", "idempotencyKey");
CREATE INDEX "ThumbnailExtractionJob_workspaceId_projectId_createdAt_idx"
  ON "ThumbnailExtractionJob"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "ThumbnailExtractionJob_status_claimExpiresAt_createdAt_idx"
  ON "ThumbnailExtractionJob"("status", "claimExpiresAt", "createdAt");
CREATE INDEX "ThumbnailExtractionJob_exportVariantId_sourceTimeMs_idx"
  ON "ThumbnailExtractionJob"("exportVariantId", "sourceTimeMs");

ALTER TABLE "SocialPost"
  ADD COLUMN "assistedCopyDraftId" UUID,
  ADD COLUMN "assistedCopyRevision" INTEGER,
  ADD COLUMN "thumbnailAssetId" UUID;

ALTER TABLE "SocialPost"
  ADD CONSTRAINT "SocialPost_assisted_copy_check" CHECK (
    ("assistedCopyDraftId" IS NULL AND "assistedCopyRevision" IS NULL)
    OR
    ("assistedCopyDraftId" IS NOT NULL AND "assistedCopyRevision" IS NOT NULL AND "assistedCopyRevision" > 0)
  );

CREATE INDEX "SocialPost_assistedCopyDraftId_idx" ON "SocialPost"("assistedCopyDraftId");
CREATE INDEX "SocialPost_thumbnailAssetId_idx" ON "SocialPost"("thumbnailAssetId");

-- Uploaded/generated assets retain owner-scoped content deduplication. Extracted
-- frames use their immutable export/time identity instead, so visually identical
-- frames from separate exports do not lose their provenance.
DROP INDEX "VisualAsset_workspaceId_fingerprint_key";
DROP INDEX "VisualAsset_userId_fingerprint_key";
CREATE UNIQUE INDEX "VisualAsset_workspaceId_fingerprint_key"
  ON "VisualAsset"("workspaceId", "fingerprint")
  WHERE "provenance" <> 'extracted';
CREATE UNIQUE INDEX "VisualAsset_userId_fingerprint_key"
  ON "VisualAsset"("userId", "fingerprint")
  WHERE "provenance" <> 'extracted';

ALTER TABLE "AssistedCopyDraft"
  ADD CONSTRAINT "AssistedCopyDraft_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AssistedCopyDraft_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AssistedCopyDraft_clipId_fkey"
  FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AssistedCopyDraft_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AssistedCopyDraft_sourceDraftId_fkey"
  FOREIGN KEY ("sourceDraftId") REFERENCES "AssistedCopyDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ThumbnailExtractionJob"
  ADD CONSTRAINT "ThumbnailExtractionJob_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ThumbnailExtractionJob_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ThumbnailExtractionJob_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ThumbnailExtractionJob_exportVariantId_fkey"
  FOREIGN KEY ("exportVariantId") REFERENCES "ClipExportVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ThumbnailExtractionJob_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "VisualAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SocialPost"
  ADD CONSTRAINT "SocialPost_assistedCopyDraftId_fkey"
  FOREIGN KEY ("assistedCopyDraftId") REFERENCES "AssistedCopyDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "SocialPost_thumbnailAssetId_fkey"
  FOREIGN KEY ("thumbnailAssetId") REFERENCES "VisualAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
