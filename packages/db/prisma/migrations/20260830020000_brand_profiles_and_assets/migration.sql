CREATE TYPE "VisualAssetKind" AS ENUM ('image', 'video');
CREATE TYPE "VisualAssetProvenance" AS ENUM ('uploaded', 'generated');
CREATE TYPE "BrandProfileAssetRole" AS ENUM ('logo', 'image', 'video', 'thumbnail', 'intro_source', 'outro_source');
CREATE TYPE "BrandFontFormat" AS ENUM ('ttf', 'otf', 'woff2');
CREATE TYPE "BrandFontRole" AS ENUM ('display', 'body', 'caption', 'fallback');

ALTER TYPE "AnalyticsEventType" ADD VALUE 'clips_ready';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'campaign_operation_started';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'campaign_operation_completed';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'review_sent';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'review_opened';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'review_changes_requested';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'campaign_approved';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'campaign_scheduled';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'generated_asset_completed';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'generated_asset_inserted';

ALTER TABLE "Project"
  ADD COLUMN "brandProfileId" UUID,
  ADD COLUMN "brandProfileSnapshot" JSONB;

ALTER TABLE "User" ADD COLUMN "defaultBrandProfileId" UUID;
ALTER TABLE "Workspace" ADD COLUMN "defaultBrandProfileId" UUID;
ALTER TABLE "UploadSession"
  ADD COLUMN "brandProfileId" UUID,
  ADD COLUMN "brandProfileSnapshot" JSONB;

CREATE TABLE "BrandProfile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID,
  "workspaceId" UUID,
  "createdByUserId" UUID NOT NULL,
  "updatedByUserId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "visualIdentity" JSONB NOT NULL,
  "voiceGuidance" JSONB NOT NULL,
  "approvalRule" TEXT NOT NULL DEFAULT 'none',
  "defaultTemplateId" UUID,
  "isCompatibility" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "BrandProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BrandProfile_owner_check" CHECK (num_nonnulls("userId", "workspaceId") = 1),
  CONSTRAINT "BrandProfile_approval_rule_check" CHECK ("approvalRule" IN ('none', 'approval_required')),
  CONSTRAINT "BrandProfile_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "BrandProfileTemplate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "profileId" UUID NOT NULL,
  "templateId" UUID NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandProfileTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VisualAsset" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID,
  "workspaceId" UUID,
  "createdByUserId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "kind" "VisualAssetKind" NOT NULL,
  "storageKey" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "durationSec" DOUBLE PRECISION,
  "fingerprint" TEXT NOT NULL,
  "provenance" "VisualAssetProvenance" NOT NULL DEFAULT 'uploaded',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "VisualAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VisualAsset_owner_check" CHECK (num_nonnulls("userId", "workspaceId") = 1),
  CONSTRAINT "VisualAsset_dimensions_check" CHECK ("width" > 0 AND "height" > 0),
  CONSTRAINT "VisualAsset_size_check" CHECK ("sizeBytes" > 0)
);

CREATE TABLE "BrandProfileAsset" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "profileId" UUID NOT NULL,
  "assetId" UUID NOT NULL,
  "role" "BrandProfileAssetRole" NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandProfileAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrandFont" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID,
  "workspaceId" UUID,
  "licenseConfirmedByUserId" UUID NOT NULL,
  "family" TEXT NOT NULL,
  "style" TEXT NOT NULL,
  "weight" INTEGER NOT NULL,
  "format" "BrandFontFormat" NOT NULL,
  "storageKey" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "licenseConfirmedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "BrandFont_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BrandFont_owner_check" CHECK (num_nonnulls("userId", "workspaceId") = 1),
  CONSTRAINT "BrandFont_weight_check" CHECK ("weight" BETWEEN 100 AND 900),
  CONSTRAINT "BrandFont_size_check" CHECK ("sizeBytes" > 0)
);

CREATE TABLE "BrandProfileFont" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "profileId" UUID NOT NULL,
  "fontId" UUID NOT NULL,
  "role" "BrandFontRole" NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandProfileFont_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrandProfileAudio" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "profileId" UUID NOT NULL,
  "audioId" UUID NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandProfileAudio_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BrandProfile_workspaceId_slug_key" ON "BrandProfile"("workspaceId", "slug");
CREATE UNIQUE INDEX "BrandProfile_userId_slug_key" ON "BrandProfile"("userId", "slug");
CREATE INDEX "BrandProfile_workspaceId_deletedAt_createdAt_idx" ON "BrandProfile"("workspaceId", "deletedAt", "createdAt");
CREATE INDEX "BrandProfile_userId_deletedAt_createdAt_idx" ON "BrandProfile"("userId", "deletedAt", "createdAt");
CREATE UNIQUE INDEX "BrandProfileTemplate_templateId_key" ON "BrandProfileTemplate"("templateId");
CREATE INDEX "BrandProfileTemplate_profileId_position_idx" ON "BrandProfileTemplate"("profileId", "position");
CREATE UNIQUE INDEX "VisualAsset_storageKey_key" ON "VisualAsset"("storageKey");
CREATE UNIQUE INDEX "VisualAsset_workspaceId_fingerprint_key" ON "VisualAsset"("workspaceId", "fingerprint");
CREATE UNIQUE INDEX "VisualAsset_userId_fingerprint_key" ON "VisualAsset"("userId", "fingerprint");
CREATE INDEX "VisualAsset_workspaceId_deletedAt_createdAt_idx" ON "VisualAsset"("workspaceId", "deletedAt", "createdAt");
CREATE INDEX "VisualAsset_userId_deletedAt_createdAt_idx" ON "VisualAsset"("userId", "deletedAt", "createdAt");
CREATE UNIQUE INDEX "BrandProfileAsset_profileId_assetId_key" ON "BrandProfileAsset"("profileId", "assetId");
CREATE INDEX "BrandProfileAsset_assetId_idx" ON "BrandProfileAsset"("assetId");
CREATE UNIQUE INDEX "BrandFont_storageKey_key" ON "BrandFont"("storageKey");
CREATE UNIQUE INDEX "BrandFont_workspaceId_fingerprint_key" ON "BrandFont"("workspaceId", "fingerprint");
CREATE UNIQUE INDEX "BrandFont_userId_fingerprint_key" ON "BrandFont"("userId", "fingerprint");
CREATE INDEX "BrandFont_workspaceId_deletedAt_createdAt_idx" ON "BrandFont"("workspaceId", "deletedAt", "createdAt");
CREATE INDEX "BrandFont_userId_deletedAt_createdAt_idx" ON "BrandFont"("userId", "deletedAt", "createdAt");
CREATE UNIQUE INDEX "BrandProfileFont_profileId_role_key" ON "BrandProfileFont"("profileId", "role");
CREATE INDEX "BrandProfileFont_fontId_idx" ON "BrandProfileFont"("fontId");
CREATE UNIQUE INDEX "BrandProfileAudio_profileId_audioId_key" ON "BrandProfileAudio"("profileId", "audioId");
CREATE INDEX "BrandProfileAudio_audioId_idx" ON "BrandProfileAudio"("audioId");
CREATE INDEX "Project_brandProfileId_idx" ON "Project"("brandProfileId");

ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_defaultTemplateId_fkey" FOREIGN KEY ("defaultTemplateId") REFERENCES "BrandTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BrandProfileTemplate" ADD CONSTRAINT "BrandProfileTemplate_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandProfileTemplate" ADD CONSTRAINT "BrandProfileTemplate_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "BrandTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisualAsset" ADD CONSTRAINT "VisualAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisualAsset" ADD CONSTRAINT "VisualAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisualAsset" ADD CONSTRAINT "VisualAsset_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrandProfileAsset" ADD CONSTRAINT "BrandProfileAsset_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandProfileAsset" ADD CONSTRAINT "BrandProfileAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "VisualAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrandFont" ADD CONSTRAINT "BrandFont_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandFont" ADD CONSTRAINT "BrandFont_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandFont" ADD CONSTRAINT "BrandFont_licenseConfirmedByUserId_fkey" FOREIGN KEY ("licenseConfirmedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrandProfileFont" ADD CONSTRAINT "BrandProfileFont_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandProfileFont" ADD CONSTRAINT "BrandProfileFont_fontId_fkey" FOREIGN KEY ("fontId") REFERENCES "BrandFont"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrandProfileAudio" ADD CONSTRAINT "BrandProfileAudio_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandProfileAudio" ADD CONSTRAINT "BrandProfileAudio_audioId_fkey" FOREIGN KEY ("audioId") REFERENCES "AudioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_defaultBrandProfileId_fkey" FOREIGN KEY ("defaultBrandProfileId") REFERENCES "BrandProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_defaultBrandProfileId_fkey" FOREIGN KEY ("defaultBrandProfileId") REFERENCES "BrandProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
