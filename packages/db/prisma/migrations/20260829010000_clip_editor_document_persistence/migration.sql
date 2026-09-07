CREATE TABLE "EditorMediaCleanupObligation" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "clipId" UUID NOT NULL,
  "cleanupClass" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimId" UUID,
  "claimExpiresAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EditorMediaCleanupObligation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EditorMediaCleanupObligation_cleanupClass_objectKey_key"
  ON "EditorMediaCleanupObligation"("cleanupClass", "objectKey");

CREATE INDEX "EditorMediaCleanupObligation_completedAt_nextAttemptAt_claimExpiresAt_idx"
  ON "EditorMediaCleanupObligation"("completedAt", "nextAttemptAt", "claimExpiresAt");

CREATE INDEX "EditorMediaCleanupObligation_clipId_completedAt_idx"
  ON "EditorMediaCleanupObligation"("clipId", "completedAt");
