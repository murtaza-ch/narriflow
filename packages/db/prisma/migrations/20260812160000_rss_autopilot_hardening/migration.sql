CREATE TYPE "AutopilotInitialImportMode" AS ENUM ('future_only', 'latest');

ALTER TABLE "AutopilotRule"
  ADD COLUMN "feedTitle" TEXT,
  ADD COLUMN "initialImportMode" "AutopilotInitialImportMode" NOT NULL DEFAULT 'future_only',
  ADD COLUMN "initialImportCount" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "initializedAt" TIMESTAMP(3),
  ADD COLUMN "lastSeenEpisodeId" TEXT,
  ADD COLUMN "lastSeenPublishedAt" TIMESTAMP(3),
  ADD COLUMN "etag" TEXT,
  ADD COLUMN "lastModified" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSuccessAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "AutopilotRule_status_nextRunAt_idx";
CREATE INDEX "AutopilotRule_status_nextRunAt_leaseExpiresAt_idx"
  ON "AutopilotRule"("status", "nextRunAt", "leaseExpiresAt");

ALTER TABLE "AutopilotRule"
  ADD CONSTRAINT "AutopilotRule_initialImportCount_check"
    CHECK ("initialImportCount" BETWEEN 1 AND 10),
  ADD CONSTRAINT "AutopilotRule_consecutiveFailures_check"
    CHECK ("consecutiveFailures" >= 0);
