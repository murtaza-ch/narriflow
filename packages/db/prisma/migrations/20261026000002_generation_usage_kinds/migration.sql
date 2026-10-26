-- Generation counts become explicit per kind (AI image or voice-over dub),
-- pinned to their UTC admission month, and survive actor deletion.
CREATE TYPE "GenerationUsageKind" AS ENUM ('image', 'dub');

ALTER TABLE "GeneratedMediaUsageReservation"
  ADD COLUMN "kind" "GenerationUsageKind",
  ADD COLUMN "periodStart" TIMESTAMP(3),
  ADD COLUMN "attachedAt" TIMESTAMP(3);

-- Every existing row is an image request. Its period is the UTC month it was
-- admitted in; a row whose job exists was attached to that job.
UPDATE "GeneratedMediaUsageReservation" AS reservation
SET
  "kind" = 'image',
  "periodStart" = date_trunc('month', reservation."createdAt"),
  "attachedAt" = CASE
    WHEN EXISTS (
      SELECT 1 FROM "GeneratedMediaJob" AS job WHERE job."id" = reservation."jobId"
    ) THEN reservation."createdAt"
    ELSE NULL
  END;

ALTER TABLE "GeneratedMediaUsageReservation"
  ALTER COLUMN "kind" SET NOT NULL,
  ALTER COLUMN "periodStart" SET NOT NULL,
  ALTER COLUMN "actorUserId" DROP NOT NULL;

ALTER TABLE "GeneratedMediaUsageReservation" DROP CONSTRAINT "GeneratedMediaUsageReservation_actorUserId_fkey";
ALTER TABLE "GeneratedMediaUsageReservation" ADD CONSTRAINT "GeneratedMediaUsageReservation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "GeneratedMediaUsageReservation_workspaceId_status_createdAt_idx";
CREATE INDEX "GeneratedMediaUsageReservation_workspaceId_kind_periodStart_idx" ON "GeneratedMediaUsageReservation"("workspaceId", "kind", "periodStart", "status");
CREATE INDEX "GeneratedMediaUsageReservation_workspaceId_kind_policy_stat_idx" ON "GeneratedMediaUsageReservation"("workspaceId", "kind", "policy", "status");
CREATE INDEX "GeneratedMediaUsageReservation_status_createdAt_idx" ON "GeneratedMediaUsageReservation"("status", "createdAt");
