ALTER TABLE "EditorMediaCleanupObligation"
  RENAME TO "MediaCleanupObligation";

ALTER TABLE "MediaCleanupObligation"
  RENAME CONSTRAINT "EditorMediaCleanupObligation_pkey"
  TO "MediaCleanupObligation_pkey";

ALTER TABLE "MediaCleanupObligation"
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'clip_editor_document_persistence',
  ALTER COLUMN "projectId" DROP NOT NULL,
  ALTER COLUMN "clipId" DROP NOT NULL;

ALTER TABLE "MediaCleanupObligation"
  ALTER COLUMN "origin" DROP DEFAULT;

DROP INDEX "EditorMediaCleanupObligation_cleanupClass_objectKey_key";

CREATE UNIQUE INDEX "MediaCleanupObligation_origin_cleanupClass_objectKey_key"
  ON "MediaCleanupObligation"("origin", "cleanupClass", "objectKey");

ALTER INDEX "EditorMediaCleanupObligation_completedAt_nextAttemptAt_claimExpiresAt_idx"
  RENAME TO "MediaCleanupObligation_completedAt_nextAttemptAt_claimExpiresAt_idx";

ALTER INDEX "EditorMediaCleanupObligation_clipId_completedAt_idx"
  RENAME TO "MediaCleanupObligation_clipId_completedAt_idx";
