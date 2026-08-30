ALTER TABLE "Clip"
  ADD COLUMN "editorDocumentVersion" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "sceneBlocks" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "censorSegments" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "mediaMotions" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "Clip"
  ADD CONSTRAINT "Clip_editorDocumentVersion_check"
  CHECK ("editorDocumentVersion" = 2);

ALTER TYPE "SocialPlatform" ADD VALUE 'facebook_reels';

CREATE TABLE "CampaignOperation" (
  "id" UUID NOT NULL, "workspaceId" UUID NOT NULL, "projectId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL, "action" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL, "validatedOptions" JSONB NOT NULL, "pricingTier" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "requestedCount" INTEGER NOT NULL, "succeededCount" INTEGER NOT NULL DEFAULT 0,
  "unchangedCount" INTEGER NOT NULL DEFAULT 0, "staleCount" INTEGER NOT NULL DEFAULT 0,
  "ineligibleCount" INTEGER NOT NULL DEFAULT 0, "failedCount" INTEGER NOT NULL DEFAULT 0,
  "retryOfId" UUID, "workflowRunId" UUID, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3), CONSTRAINT "CampaignOperation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignOperation_workspaceId_idempotencyKey_key" ON "CampaignOperation"("workspaceId", "idempotencyKey");
CREATE INDEX "CampaignOperation_projectId_createdAt_idx" ON "CampaignOperation"("projectId", "createdAt" DESC);
CREATE UNIQUE INDEX "CampaignOperation_retryOfId_key" ON "CampaignOperation"("retryOfId");
ALTER TABLE "CampaignOperation" ADD CONSTRAINT "CampaignOperation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE;
ALTER TABLE "CampaignOperation" ADD CONSTRAINT "CampaignOperation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE;
ALTER TABLE "CampaignOperation" ADD CONSTRAINT "CampaignOperation_retryOfId_fkey" FOREIGN KEY ("retryOfId") REFERENCES "CampaignOperation"("id") ON DELETE SET NULL;

CREATE TABLE "CampaignOperationItem" (
  "id" UUID NOT NULL, "operationId" UUID NOT NULL, "clipId" UUID, "requestedClipId" UUID NOT NULL,
  "expectedEditorRevision" INTEGER, "exportId" UUID, "status" TEXT NOT NULL DEFAULT 'pending',
  "errorCode" TEXT, "result" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3), CONSTRAINT "CampaignOperationItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignOperationItem_operationId_requestedClipId_key" ON "CampaignOperationItem"("operationId", "requestedClipId");
CREATE INDEX "CampaignOperationItem_clipId_idx" ON "CampaignOperationItem"("clipId");
CREATE INDEX "CampaignOperationItem_exportId_idx" ON "CampaignOperationItem"("exportId");
ALTER TABLE "CampaignOperationItem" ADD CONSTRAINT "CampaignOperationItem_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "CampaignOperation"("id") ON DELETE CASCADE;
ALTER TABLE "CampaignOperationItem" ADD CONSTRAINT "CampaignOperationItem_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE SET NULL;
ALTER TABLE "CampaignOperationItem" ADD CONSTRAINT "CampaignOperationItem_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id") ON DELETE SET NULL;

CREATE TABLE "ExportBundle" (
  "id" UUID NOT NULL, "operationId" UUID NOT NULL, "workflowRunId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued', "attemptStorageKey" TEXT, "storageKey" TEXT,
  "manifest" JSONB NOT NULL, "sizeBytes" BIGINT, "checksumSha256" TEXT, "expiresAt" TIMESTAMP(3),
  "errorCode" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3), CONSTRAINT "ExportBundle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExportBundle_operationId_key" ON "ExportBundle"("operationId");
CREATE UNIQUE INDEX "ExportBundle_workflowRunId_key" ON "ExportBundle"("workflowRunId");
CREATE INDEX "ExportBundle_status_createdAt_idx" ON "ExportBundle"("status", "createdAt");
ALTER TABLE "ExportBundle" ADD CONSTRAINT "ExportBundle_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "CampaignOperation"("id") ON DELETE CASCADE;
ALTER TABLE "ExportBundle" ADD CONSTRAINT "ExportBundle_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE;

CREATE TABLE "ReviewRound" (
  "id" UUID NOT NULL, "workspaceId" UUID NOT NULL, "projectId" UUID NOT NULL, "createdByUserId" UUID NOT NULL,
  "revision" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'open', "title" TEXT NOT NULL, "message" TEXT,
  "accessTokenHash" TEXT NOT NULL, "passcodeHash" TEXT, "allowDownloads" BOOLEAN NOT NULL DEFAULT false,
  "approvalRequired" BOOLEAN NOT NULL DEFAULT true, "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3), "decision" TEXT, "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewRound_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReviewRound_accessTokenHash_key" ON "ReviewRound"("accessTokenHash");
CREATE UNIQUE INDEX "ReviewRound_projectId_revision_key" ON "ReviewRound"("projectId", "revision");
CREATE INDEX "ReviewRound_workspaceId_createdAt_idx" ON "ReviewRound"("workspaceId", "createdAt" DESC);
CREATE INDEX "ReviewRound_status_expiresAt_idx" ON "ReviewRound"("status", "expiresAt");
ALTER TABLE "ReviewRound" ADD CONSTRAINT "ReviewRound_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE;
ALTER TABLE "ReviewRound" ADD CONSTRAINT "ReviewRound_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE;

CREATE TABLE "ReviewRoundItem" (
  "id" UUID NOT NULL, "reviewRoundId" UUID NOT NULL, "clipId" UUID NOT NULL, "exportId" UUID NOT NULL,
  "editorRevision" INTEGER NOT NULL, "position" INTEGER NOT NULL, "selectedVariantIds" JSONB NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT true, "currentDecision" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewRoundItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReviewRoundItem_reviewRoundId_clipId_key" ON "ReviewRoundItem"("reviewRoundId", "clipId");
CREATE INDEX "ReviewRoundItem_exportId_idx" ON "ReviewRoundItem"("exportId");
ALTER TABLE "ReviewRoundItem" ADD CONSTRAINT "ReviewRoundItem_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE;
ALTER TABLE "ReviewRoundItem" ADD CONSTRAINT "ReviewRoundItem_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE RESTRICT;
ALTER TABLE "ReviewRoundItem" ADD CONSTRAINT "ReviewRoundItem_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id") ON DELETE RESTRICT;

CREATE TABLE "ReviewComment" (
  "id" UUID NOT NULL, "reviewRoundId" UUID NOT NULL, "itemId" UUID, "parentId" UUID,
  "authorKind" TEXT NOT NULL, "authorName" TEXT NOT NULL, "authorGrantHash" TEXT NOT NULL, "authorGuestId" UUID,
  "body" TEXT NOT NULL, "timestampSec" DOUBLE PRECISION,
  "resolvedAt" TIMESTAMP(3), "editedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ReviewComment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReviewComment_reviewRoundId_createdAt_idx" ON "ReviewComment"("reviewRoundId", "createdAt");
CREATE INDEX "ReviewComment_parentId_idx" ON "ReviewComment"("parentId");
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE;
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ReviewRoundItem"("id") ON DELETE CASCADE;
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ReviewComment"("id") ON DELETE CASCADE;

CREATE TABLE "ReviewDecision" (
  "id" UUID NOT NULL, "reviewRoundId" UUID NOT NULL, "itemId" UUID, "actorGuestId" UUID, "decision" TEXT NOT NULL,
  "actorKind" TEXT NOT NULL, "actorName" TEXT NOT NULL, "reason" TEXT, "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewDecision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReviewDecision_reviewRoundId_createdAt_idx" ON "ReviewDecision"("reviewRoundId", "createdAt" DESC);
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE;
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ReviewRoundItem"("id") ON DELETE CASCADE;

CREATE TABLE "ReviewGuest" (
  "id" UUID NOT NULL, "reviewRoundId" UUID NOT NULL, "displayName" TEXT NOT NULL, "emailHash" TEXT NOT NULL,
  "emailEncrypted" TEXT NOT NULL, "sessionGrantHash" TEXT NOT NULL, "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ReviewGuest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReviewGuest_reviewRoundId_emailHash_key" ON "ReviewGuest"("reviewRoundId", "emailHash");
CREATE INDEX "ReviewGuest_reviewRoundId_lastSeenAt_idx" ON "ReviewGuest"("reviewRoundId", "lastSeenAt" DESC);
ALTER TABLE "ReviewGuest" ADD CONSTRAINT "ReviewGuest_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE;
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_authorGuestId_fkey" FOREIGN KEY ("authorGuestId") REFERENCES "ReviewGuest"("id") ON DELETE SET NULL;
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_actorGuestId_fkey" FOREIGN KEY ("actorGuestId") REFERENCES "ReviewGuest"("id") ON DELETE SET NULL;

CREATE TABLE "ReviewAuditEvent" (
  "id" UUID NOT NULL, "reviewRoundId" UUID NOT NULL, "guestId" UUID, "kind" TEXT NOT NULL, "targetId" UUID,
  "metadata" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ReviewAuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReviewAuditEvent_reviewRoundId_createdAt_idx" ON "ReviewAuditEvent"("reviewRoundId", "createdAt");
CREATE INDEX "ReviewAuditEvent_kind_createdAt_idx" ON "ReviewAuditEvent"("kind", "createdAt");
ALTER TABLE "ReviewAuditEvent" ADD CONSTRAINT "ReviewAuditEvent_reviewRoundId_fkey" FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE;
ALTER TABLE "ReviewAuditEvent" ADD CONSTRAINT "ReviewAuditEvent_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "ReviewGuest"("id") ON DELETE SET NULL;

CREATE TABLE "SceneTemplate" (
  "id" UUID NOT NULL, "profileId" UUID NOT NULL, "sourceAssetId" UUID, "createdByUserId" UUID NOT NULL,
  "name" TEXT NOT NULL, "role" TEXT NOT NULL DEFAULT 'inline', "definition" JSONB NOT NULL, "fingerprint" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, "deletedAt" TIMESTAMP(3), CONSTRAINT "SceneTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SceneTemplate_profileId_name_key" ON "SceneTemplate"("profileId", "name");
CREATE INDEX "SceneTemplate_profileId_role_deletedAt_idx" ON "SceneTemplate"("profileId", "role", "deletedAt");
CREATE INDEX "SceneTemplate_sourceAssetId_idx" ON "SceneTemplate"("sourceAssetId");
ALTER TABLE "SceneTemplate" ADD CONSTRAINT "SceneTemplate_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BrandProfile"("id") ON DELETE CASCADE;
ALTER TABLE "SceneTemplate" ADD CONSTRAINT "SceneTemplate_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "VisualAsset"("id") ON DELETE RESTRICT;

ALTER TABLE "BrandProfile"
  ADD COLUMN "defaultIntroSceneTemplateId" UUID,
  ADD COLUMN "defaultOutroSceneTemplateId" UUID;
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_defaultIntroSceneTemplateId_fkey" FOREIGN KEY ("defaultIntroSceneTemplateId") REFERENCES "SceneTemplate"("id") ON DELETE SET NULL;
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_defaultOutroSceneTemplateId_fkey" FOREIGN KEY ("defaultOutroSceneTemplateId") REFERENCES "SceneTemplate"("id") ON DELETE SET NULL;
