ALTER TABLE "Clip"
ADD COLUMN "brollPlacements" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "GeneratedMediaInsertion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "assetFingerprint" TEXT NOT NULL,
    "assetProvenance" "VisualAssetProvenance" NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "editorRevision" INTEGER NOT NULL,
    "documentSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedMediaInsertion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GeneratedMediaInsertion_kind_check"
      CHECK ("kind" IN ('broll', 'scene_block')),
    CONSTRAINT "GeneratedMediaInsertion_asset_fingerprint_check"
      CHECK ("assetFingerprint" ~ '^[A-Fa-f0-9]{32,128}$'),
    CONSTRAINT "GeneratedMediaInsertion_editor_revision_check"
      CHECK ("editorRevision" > 0),
    CONSTRAINT "GeneratedMediaInsertion_document_snapshot_check"
      CHECK (jsonb_typeof("documentSnapshot") = 'object')
);

CREATE UNIQUE INDEX "GeneratedMediaInsertion_workspaceId_idempotencyKey_key"
ON "GeneratedMediaInsertion"("workspaceId", "idempotencyKey");

CREATE INDEX "GeneratedMediaInsertion_clipId_editorRevision_idx"
ON "GeneratedMediaInsertion"("clipId", "editorRevision");

CREATE INDEX "GeneratedMediaInsertion_jobId_createdAt_idx"
ON "GeneratedMediaInsertion"("jobId", "createdAt");

CREATE INDEX "GeneratedMediaInsertion_assetId_idx"
ON "GeneratedMediaInsertion"("assetId");

ALTER TABLE "GeneratedMediaInsertion"
ADD CONSTRAINT "GeneratedMediaInsertion_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GeneratedMediaInsertion"
ADD CONSTRAINT "GeneratedMediaInsertion_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GeneratedMediaInsertion"
ADD CONSTRAINT "GeneratedMediaInsertion_clipId_fkey"
FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GeneratedMediaInsertion"
ADD CONSTRAINT "GeneratedMediaInsertion_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "GeneratedMediaJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GeneratedMediaInsertion"
ADD CONSTRAINT "GeneratedMediaInsertion_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GeneratedMediaInsertion"
ADD CONSTRAINT "GeneratedMediaInsertion_assetId_fkey"
FOREIGN KEY ("assetId") REFERENCES "VisualAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
