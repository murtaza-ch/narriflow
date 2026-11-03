-- Timestamp columns hold UTC wall-clock time. Defaults and triggers that read
-- CURRENT_TIMESTAMP convert it to UTC so they do not depend on the session time zone.
ALTER TABLE "NotificationLedger" ALTER COLUMN "operationDeadlineAt" SET DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + '23 hours'::interval);
ALTER TABLE "ReviewNotificationLedger" ALTER COLUMN "operationDeadlineAt" SET DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + '23 hours'::interval);
ALTER TABLE "GrantPauseNotificationLedger" ALTER COLUMN "operationDeadlineAt" SET DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + '23 hours'::interval);
ALTER TABLE "WebhookDisabledNotificationLedger" ALTER COLUMN "operationDeadlineAt" SET DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + '23 hours'::interval);
ALTER TABLE "ZoomWebhookJob" ALTER COLUMN "operationDeadlineAt" SET DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + '30 days'::interval);
ALTER TABLE "ExportBundle" ALTER COLUMN "operationDeadlineAt" SET DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + '00:45:00'::interval);

CREATE OR REPLACE FUNCTION generated_media_native_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" THEN
  IF NOT (OLD.status::text IN ('queued','processing','running','waiting','preparing') AND execution_restore_row_allowed(OLD."deploymentEpoch",NEW."deploymentEpoch",'generated_media',OLD.id,OLD."createdAt")
   AND NEW.generation=OLD.generation+1 AND (to_jsonb(NEW)-ARRAY['deploymentEpoch','generation','status','claimId','executorOwner','claimExpiresAt','updatedAt','resultState','outcomeUnknown','retryAt','errorCode']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['deploymentEpoch','generation','status','claimId','executorOwner','claimExpiresAt','updatedAt','resultState','outcomeUnknown','retryAt','errorCode']) AND NEW.status IN ('queued','waiting') AND ((NEW."outcomeUnknown" AND NEW."claimId" IS NOT DISTINCT FROM OLD."claimId") OR (NOT NEW."outcomeUnknown" AND NEW."claimId" IS NULL)) AND NEW."executorOwner" IS NULL AND NEW."claimExpiresAt" IS NULL
 AND (NEW."resultState" IS NOT DISTINCT FROM OLD."resultState"-'inputPlan')
 AND (NOT OLD."outcomeUnknown" OR NEW."outcomeUnknown")
 AND (NOT EXISTS(SELECT 1 FROM "ExecutionAttempt" a WHERE a."attemptToken"=OLD."claimId" AND a."processStartedAt" IS NOT NULL) OR OLD."executionMode"='recover' OR (NEW."outcomeUnknown" AND NEW.status='waiting'))) THEN
   RAISE EXCEPTION 'native restore transition refused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;

 IF (NEW."id",NEW."workspaceId",NEW."projectId",NEW."clipId",NEW."createdByUserId",NEW."workspaceOwnerUserId",NEW."isPersonalWorkspace",NEW."requestFingerprint",NEW."promptFingerprint",NEW."promptOrigin",NEW."sourceStartSec",NEW."sourceEndSec",NEW."sourceCueAtSec",NEW."aspectRatio",NEW."style",NEW."title",NEW."provider",NEW."providerModel",NEW."providerQuality",NEW."outputByteLimit",NEW."usageReservationId",NEW."deploymentEpoch",NEW."createdAt") IS DISTINCT FROM
    (OLD."id",OLD."workspaceId",OLD."projectId",OLD."clipId",OLD."createdByUserId",OLD."workspaceOwnerUserId",OLD."isPersonalWorkspace",OLD."requestFingerprint",OLD."promptFingerprint",OLD."promptOrigin",OLD."sourceStartSec",OLD."sourceEndSec",OLD."sourceCueAtSec",OLD."aspectRatio",OLD."style",OLD."title",OLD."provider",OLD."providerModel",OLD."providerQuality",OLD."outputByteLimit",OLD."usageReservationId",OLD."deploymentEpoch",OLD."createdAt") THEN
  RAISE EXCEPTION 'generated media input is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."protectedPrompt" IS DISTINCT FROM OLD."protectedPrompt" AND NOT (OLD."status" IN ('completed','failed','rejected','cancelled') AND OLD."promptExpiresAt"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND NEW."protectedPrompt"='') THEN
  RAISE EXCEPTION 'generated prompt is immutable until retention expiry' USING ERRCODE='23514';
 END IF;
 IF OLD."status" IN ('completed','failed','rejected','cancelled') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
  RAISE EXCEPTION 'generated media terminal state is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."generation" IS DISTINCT FROM OLD."generation" AND NOT (NEW."generation"=OLD."generation"+1 AND NEW."status"='queued' AND NEW."claimId" IS NULL AND NEW."executorOwner" IS NULL AND NEW."claimExpiresAt" IS NULL AND NEW."operationDeadlineAt" IS NULL AND NOT NEW."outcomeUnknown") THEN
  RAISE EXCEPTION 'generated media retry generation is invalid' USING ERRCODE='23514';
 END IF;
 IF NEW."generation"=OLD."generation" AND (NEW."executionMode",NEW."resultState"->'recovery') IS DISTINCT FROM (OLD."executionMode",OLD."resultState"->'recovery') THEN
  RAISE EXCEPTION 'generated media recovery source is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."chargedAttempts" IS DISTINCT FROM OLD."chargedAttempts" AND NOT (NEW."chargedAttempts"=OLD."chargedAttempts"+1 AND OLD."status"='running' AND NEW."claimId"=OLD."claimId" AND NEW."executorOwner"=OLD."executorOwner") THEN
  RAISE EXCEPTION 'generated media charged start is invalid' USING ERRCODE='23514';
 END IF;
 IF NEW."maxAttempts" IS DISTINCT FROM OLD."maxAttempts" AND NOT (OLD."outcomeUnknown" AND NEW."generation"=OLD."generation"+1 AND NEW."maxAttempts" BETWEEN OLD."chargedAttempts"+1 AND OLD."chargedAttempts"+10) THEN
  RAISE EXCEPTION 'generated media budget needs explicit reconciliation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
