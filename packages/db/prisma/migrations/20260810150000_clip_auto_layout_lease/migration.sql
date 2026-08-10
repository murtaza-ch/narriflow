-- Auto-layout is CPU work and downloads a preview proxy. Make its queue
-- durable so horizontally-scaled workers cannot analyze the same clip at the
-- same time, and so failures/backoff survive process restarts.
CREATE TYPE "ClipAutoLayoutStatus" AS ENUM ('pending', 'processing', 'completed');

ALTER TABLE "Clip"
  ADD COLUMN "autoLayoutStatus" "ClipAutoLayoutStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "autoLayoutClaimToken" UUID,
  ADD COLUMN "autoLayoutLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "autoLayoutAttemptCount" INTEGER NOT NULL DEFAULT 0;

-- Preserve the state of plans written before this migration.
UPDATE "Clip"
SET "autoLayoutStatus" = 'completed'
WHERE "autoLayoutAnalysis" IS NOT NULL;

CREATE INDEX "Clip_autoLayoutStatus_autoLayoutLeaseExpiresAt_idx"
  ON "Clip"("autoLayoutStatus", "autoLayoutLeaseExpiresAt");
