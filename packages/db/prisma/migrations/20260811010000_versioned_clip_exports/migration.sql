-- Immutable, revision-bound delivery artifacts.
CREATE TYPE "ClipExportStatus" AS ENUM (
  'queued',
  'rendering',
  'partial_ready',
  'ready',
  'failed'
);

CREATE TABLE "ClipExport" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "clipId" UUID NOT NULL,
  "editorRevision" INTEGER NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "resolution" TEXT NOT NULL,
  "watermark" BOOLEAN NOT NULL,
  "status" "ClipExportStatus" NOT NULL DEFAULT 'queued',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "workflowRunId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ClipExport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClipExportVariant" (
  "id" UUID NOT NULL,
  "exportId" UUID NOT NULL,
  "aspectRatio" "ClipAspectRatio" NOT NULL,
  "resolution" TEXT NOT NULL,
  "watermark" BOOLEAN NOT NULL,
  "status" "ClipRenderStatus" NOT NULL DEFAULT 'pending',
  "storageKey" TEXT,
  "sizeBytes" BIGINT,
  "durationSec" DOUBLE PRECISION,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClipExportVariant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClipShareLink" (
  "id" UUID NOT NULL,
  "exportId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClipShareLink_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ClipRender"
  ADD COLUMN "exportVariantId" UUID,
  ADD COLUMN "editorRevision" INTEGER,
  ADD COLUMN "clipSnapshot" JSONB;

-- Preserve the mutable latest-render contract only for ordinary project
-- renders. Export-bound render jobs are versioned and may coexist.
DROP INDEX "ClipRender_clipId_aspectRatio_key";
CREATE UNIQUE INDEX "ClipRender_latest_clip_aspect_key"
  ON "ClipRender"("clipId", "aspectRatio")
  WHERE "exportVariantId" IS NULL;
CREATE INDEX "ClipRender_clipId_aspectRatio_idx"
  ON "ClipRender"("clipId", "aspectRatio");

CREATE UNIQUE INDEX "ClipRender_exportVariantId_key"
  ON "ClipRender"("exportVariantId");
CREATE UNIQUE INDEX "ClipExport_clipId_fingerprint_key"
  ON "ClipExport"("clipId", "fingerprint");
CREATE INDEX "ClipExport_projectId_createdAt_idx"
  ON "ClipExport"("projectId", "createdAt" DESC);
CREATE INDEX "ClipExport_clipId_createdAt_idx"
  ON "ClipExport"("clipId", "createdAt" DESC);
CREATE INDEX "ClipExport_status_updatedAt_idx"
  ON "ClipExport"("status", "updatedAt");
CREATE UNIQUE INDEX "ClipExportVariant_exportId_aspectRatio_key"
  ON "ClipExportVariant"("exportId", "aspectRatio");
CREATE INDEX "ClipExportVariant_exportId_status_idx"
  ON "ClipExportVariant"("exportId", "status");
CREATE UNIQUE INDEX "ClipShareLink_tokenHash_key"
  ON "ClipShareLink"("tokenHash");
CREATE INDEX "ClipShareLink_exportId_revokedAt_idx"
  ON "ClipShareLink"("exportId", "revokedAt");
CREATE INDEX "ClipShareLink_expiresAt_idx"
  ON "ClipShareLink"("expiresAt");

ALTER TABLE "ClipExport"
  ADD CONSTRAINT "ClipExport_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ClipExport_clipId_fkey"
  FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClipExportVariant"
  ADD CONSTRAINT "ClipExportVariant_exportId_fkey"
  FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClipShareLink"
  ADD CONSTRAINT "ClipShareLink_exportId_fkey"
  FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClipRender"
  ADD CONSTRAINT "ClipRender_exportVariantId_fkey"
  FOREIGN KEY ("exportVariantId") REFERENCES "ClipExportVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
