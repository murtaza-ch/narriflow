-- Processing usage is recorded, not derived from live Project rows.
BEGIN;

CREATE TYPE "ProcessingIntakeKind" AS ENUM ('upload', 'link', 'rss');
CREATE TYPE "ProcessingUsageState" AS ENUM ('reserved', 'settled', 'released', 'refunded');

CREATE TABLE "ProcessingUsageReservation" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "actorUserId" UUID,
  "intakeKind" "ProcessingIntakeKind" NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "reservedSeconds" INTEGER NOT NULL,
  "settledSeconds" INTEGER,
  "state" "ProcessingUsageState" NOT NULL DEFAULT 'reserved',
  "reason" TEXT,
  "refundedByUserId" UUID,
  "settledAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "refundedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProcessingUsageReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProcessingUsageReservation_seconds_check" CHECK (
    "reservedSeconds" >= 0 AND ("settledSeconds" IS NULL OR "settledSeconds" >= 0)
  )
);

CREATE UNIQUE INDEX "ProcessingUsageReservation_projectId_key" ON "ProcessingUsageReservation"("projectId");
CREATE INDEX "ProcessingUsageReservation_workspaceId_periodStart_state_idx" ON "ProcessingUsageReservation"("workspaceId", "periodStart", "state");
CREATE INDEX "ProcessingUsageReservation_state_updatedAt_idx" ON "ProcessingUsageReservation"("state", "updatedAt");

ALTER TABLE "ProcessingUsageReservation" ADD CONSTRAINT "ProcessingUsageReservation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProcessingUsageReservation" ADD CONSTRAINT "ProcessingUsageReservation_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Projects that already reached transcription keep their charge in the month
-- they were created. Regeneration requires a settled row.
INSERT INTO "ProcessingUsageReservation" (
  "id", "projectId", "workspaceId", "actorUserId", "intakeKind", "periodStart",
  "reservedSeconds", "settledSeconds", "state", "settledAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), p."id", p."workspaceId", p."createdByUserId",
  CASE p."sourceType" WHEN 'rss' THEN 'rss'::"ProcessingIntakeKind"
    WHEN 'upload' THEN 'upload'::"ProcessingIntakeKind"
    ELSE 'link'::"ProcessingIntakeKind" END,
  date_trunc('month', p."createdAt"),
  COALESCE(p."sourceDurationSeconds", 0), COALESCE(p."sourceDurationSeconds", 0),
  'settled', p."createdAt", p."createdAt", CURRENT_TIMESTAMP
FROM "Project" p
WHERE EXISTS (SELECT 1 FROM "WorkflowRun" r WHERE r."projectId" = p."id" AND r."stage" = 'stt');

-- Intakes still importing or awaiting their generation handoff reserve their
-- known or declared duration, or the tier's per-video cap, in the current
-- month. Anything else that never transcribed is admitted at settlement.
INSERT INTO "ProcessingUsageReservation" (
  "id", "projectId", "workspaceId", "actorUserId", "intakeKind", "periodStart",
  "reservedSeconds", "state", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), p."id", p."workspaceId", p."createdByUserId",
  CASE p."sourceType" WHEN 'rss' THEN 'rss'::"ProcessingIntakeKind"
    WHEN 'upload' THEN 'upload'::"ProcessingIntakeKind"
    ELSE 'link'::"ProcessingIntakeKind" END,
  date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  COALESCE(p."sourceDurationSeconds", CASE w."pricingTier" WHEN 'free' THEN 1800 WHEN 'creator' THEN 5400 ELSE 10800 END),
  'reserved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Project" p
JOIN "Workspace" w ON w."id" = p."workspaceId"
JOIN LATERAL (
  SELECT j."status", j."generationHandoffAt" FROM "IngestJob" j
  WHERE j."projectId" = p."id"
  ORDER BY j."createdAt" DESC, j."id" DESC
  LIMIT 1
) latest ON TRUE
WHERE p."ingestStatus" <> 'failed'
  AND (latest."status" IN ('queued', 'running')
    OR (latest."status" = 'completed' AND latest."generationHandoffAt" IS NULL))
  AND NOT EXISTS (SELECT 1 FROM "WorkflowRun" r WHERE r."projectId" = p."id" AND r."stage" = 'stt');

INSERT INTO "ProcessingUsageReservation" (
  "id", "projectId", "workspaceId", "actorUserId", "intakeKind", "periodStart",
  "reservedSeconds", "state", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), s."preallocatedProjectId", s."workspaceId",
  (SELECT u."id" FROM "User" u WHERE u."id" = s."actorUserId"),
  'upload', date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CASE w."pricingTier" WHEN 'free' THEN 1800 WHEN 'creator' THEN 5400 ELSE 10800 END,
  'reserved', s."createdAt", CURRENT_TIMESTAMP
FROM "UploadSession" s
JOIN "Workspace" w ON w."id" = s."workspaceId"
WHERE s."status" IN ('initiating', 'uploading', 'finalizing', 'reconciling')
  AND NOT EXISTS (SELECT 1 FROM "ProcessingUsageReservation" r WHERE r."projectId" = s."preallocatedProjectId");

COMMIT;
