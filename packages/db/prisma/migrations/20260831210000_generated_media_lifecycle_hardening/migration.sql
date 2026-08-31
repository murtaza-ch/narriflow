BEGIN;

LOCK TABLE "GeneratedMediaJob", "GenerationUsageReservation"
  IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "GeneratedMediaJob")
    OR EXISTS (SELECT 1 FROM "GenerationUsageReservation") THEN
    RAISE EXCEPTION 'generated_media_lifecycle_preexisting_rows_require_reset';
  END IF;
END
$$;

ALTER TABLE "GeneratedMediaJob"
  ADD COLUMN "promptKeyVersion" TEXT NOT NULL;

ALTER TABLE "GeneratedMediaJob"
  DROP CONSTRAINT "GeneratedMediaJob_status_check";

ALTER TABLE "GeneratedMediaJob"
  ADD CONSTRAINT "GeneratedMediaJob_status_check" CHECK (
    "status" IN (
      'queued',
      'running',
      'waiting',
      'reconciliation_required',
      'completed',
      'failed',
      'rejected',
      'cancelled'
    )
  ),
  ADD CONSTRAINT "GeneratedMediaJob_prompt_key_version_check" CHECK (
    char_length("promptKeyVersion") BETWEEN 1 AND 64
  );

ALTER TABLE "GeneratedMediaJob"
  DROP CONSTRAINT "GeneratedMediaJob_projectId_fkey";

DROP INDEX "GeneratedMediaJob_resultAssetId_key";

CREATE INDEX "GeneratedMediaJob_resultAssetId_idx"
  ON "GeneratedMediaJob"("resultAssetId");

ALTER TABLE "GenerationUsageReservation"
  ADD COLUMN "usagePolicy" TEXT NOT NULL,
  ADD COLUMN "allowancePeriod" TEXT NOT NULL,
  ADD COLUMN "allowanceLimitUnits" INTEGER NOT NULL,
  ADD COLUMN "allowanceStartedAt" TIMESTAMP(3),
  ADD COLUMN "allowanceEndsAt" TIMESTAMP(3),
  ADD COLUMN "dailyAbuseLimitUnits" INTEGER NOT NULL,
  ADD COLUMN "dailyAbuseStartedAt" TIMESTAMP(3) NOT NULL,
  ADD COLUMN "dailyAbuseEndsAt" TIMESTAMP(3) NOT NULL;

ALTER TABLE "GenerationUsageReservation"
  ADD CONSTRAINT "GenerationUsageReservation_policy_check" CHECK (
    "usagePolicy" IN ('trial_metered', 'metered')
  ),
  ADD CONSTRAINT "GenerationUsageReservation_allowance_check" CHECK (
    "allowanceLimitUnits" > 0
    AND (
      (
        "usagePolicy" = 'trial_metered'
        AND
        "allowancePeriod" = 'lifetime'
        AND "allowanceStartedAt" IS NULL
        AND "allowanceEndsAt" IS NULL
      )
      OR (
        "usagePolicy" = 'metered'
        AND
        "allowancePeriod" = 'calendar_day_utc'
        AND "allowanceStartedAt" IS NOT NULL
        AND "allowanceEndsAt" IS NOT NULL
        AND "allowanceEndsAt" > "allowanceStartedAt"
      )
    )
  ),
  ADD CONSTRAINT "GenerationUsageReservation_daily_abuse_check" CHECK (
    "dailyAbuseLimitUnits" > 0
    AND "dailyAbuseEndsAt" > "dailyAbuseStartedAt"
  );

CREATE INDEX "GenerationUsageReservation_workspaceId_kind_createdAt_idx"
  ON "GenerationUsageReservation"("workspaceId", "kind", "createdAt");

COMMIT;
