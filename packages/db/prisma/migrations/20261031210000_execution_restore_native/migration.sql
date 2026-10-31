-- Explicit rs2 metadata transitions: no normal retry can change an epoch,
-- input identity, accepted budget, or deadline through these branches.
CREATE FUNCTION execution_restore_row_allowed(old_epoch integer,new_epoch integer,kind text,subject_id uuid,accepted_at timestamp) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM "ExecutionEpoch" e WHERE e.id=1 AND NOT e."admissionOpen" AND e.epoch=new_epoch AND old_epoch<new_epoch
  AND accepted_at<=e."changedAt" AND EXISTS(SELECT 1 FROM "ExecutionDispatch" d WHERE d."deploymentEpoch"=new_epoch AND d.kind='maintenance' AND d."subjectKind"='maintenance'
   AND d."subjectId"='rs2.'||(new_epoch-1)::text||'.'||(new_epoch-1)::text||'.'||new_epoch::text||'.'||(extract(epoch FROM (e."changedAt" AT TIME ZONE 'UTC'))*1000)::bigint::text||'.attempts')
  AND NOT EXISTS(SELECT 1 FROM "ExecutionAttempt" a JOIN "ExecutionDispatch" d ON d.id=a."dispatchId"
    WHERE d."subjectKind"=kind AND d."subjectId"=subject_id::text AND a.status IN ('admitted','running')))
$$;

CREATE OR REPLACE FUNCTION native_validation_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" THEN
  IF NOT (OLD.status::text IN ('queued','processing','running','waiting','preparing') AND execution_restore_row_allowed(OLD."deploymentEpoch",NEW."deploymentEpoch",'native_validation',OLD.id,OLD."createdAt")
   AND NEW.generation=OLD.generation+1 AND (to_jsonb(NEW)-ARRAY['deploymentEpoch','generation','inputHash','status','attemptToken','executorOwner','leaseExpiresAt','updatedAt']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['deploymentEpoch','generation','inputHash','status','attemptToken','executorOwner','leaseExpiresAt','updatedAt']) AND NEW.status='queued' AND NEW."attemptToken" IS NULL AND NEW."executorOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL) THEN
   RAISE EXCEPTION 'native restore transition refused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;

  IF (NEW."id",NEW."workspaceId",NEW."createdByUserId",NEW."ownerUserId",NEW."ownerWorkspaceId",NEW."kind",NEW."requestFingerprint",NEW."input",NEW."inputHash",NEW."inputStorageKey",NEW."inputEtag",NEW."inputByteLength",NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id",OLD."workspaceId",OLD."createdByUserId",OLD."ownerUserId",OLD."ownerWorkspaceId",OLD."kind",OLD."requestFingerprint",OLD."input",OLD."inputHash",OLD."inputStorageKey",OLD."inputEtag",OLD."inputByteLength",OLD."createdAt") THEN
    RAISE EXCEPTION 'native validation input is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."generation" IS DISTINCT FROM OLD."generation" AND NOT (NEW."generation" = OLD."generation" + 1 AND NEW."status" = 'queued' AND NEW."attemptToken" IS NULL AND NEW."executorOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL) THEN
    RAISE EXCEPTION 'native validation retry generation is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" AND NOT (NEW."deploymentEpoch" > OLD."deploymentEpoch" AND NEW."deploymentEpoch" = (SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1) AND NEW."status" = 'queued' AND NEW."executorOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL) THEN
    RAISE EXCEPTION 'native validation epoch is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW."operationDeadlineAt" IS DISTINCT FROM OLD."operationDeadlineAt" AND NEW."deploymentEpoch" = OLD."deploymentEpoch" THEN
    RAISE EXCEPTION 'native validation deadline is immutable within its epoch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION outbound_probe_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" THEN
  IF NOT (OLD.status::text IN ('queued','processing','running','waiting','preparing') AND execution_restore_row_allowed(OLD."deploymentEpoch",NEW."deploymentEpoch",'outbound_probe',OLD.id,OLD."createdAt")
   AND NEW.generation=OLD.generation+1 AND (to_jsonb(NEW)-ARRAY['deploymentEpoch','generation','inputHash','status','attemptToken','executorOwner','leaseExpiresAt','updatedAt']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['deploymentEpoch','generation','inputHash','status','attemptToken','executorOwner','leaseExpiresAt','updatedAt']) AND NEW.status='queued' AND NEW."attemptToken" IS NULL AND NEW."executorOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL) THEN
   RAISE EXCEPTION 'native restore transition refused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;

 IF (NEW."id",NEW."workspaceId",NEW."createdByUserId",NEW."kind",NEW."requestFingerprint",NEW."input",NEW."inputHash",NEW."createdAt",NEW."operationDeadlineAt")
 IS DISTINCT FROM (OLD."id",OLD."workspaceId",OLD."createdByUserId",OLD."kind",OLD."requestFingerprint",OLD."input",OLD."inputHash",OLD."createdAt",OLD."operationDeadlineAt") THEN
  RAISE EXCEPTION 'outbound probe input is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."generation" IS DISTINCT FROM OLD."generation" AND NOT (NEW."generation"=OLD."generation"+1 AND NEW."status"='queued' AND NEW."attemptToken" IS NULL AND NEW."executorOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL) THEN
  RAISE EXCEPTION 'outbound probe retry generation is invalid' USING ERRCODE='23514';
 END IF;
 IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" THEN
  RAISE EXCEPTION 'outbound probe epoch is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION outbound_delivery_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" THEN
  IF NOT (OLD.status::text IN ('queued','processing','running','waiting','preparing') AND execution_restore_row_allowed(OLD."deploymentEpoch",NEW."deploymentEpoch",'outbound_delivery',OLD.id,OLD."createdAt")
   AND NEW.generation=OLD.generation+1 AND (to_jsonb(NEW)-ARRAY['deploymentEpoch','generation','inputHash','status','attemptToken','executorOwner','leaseExpiresAt','updatedAt']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['deploymentEpoch','generation','inputHash','status','attemptToken','executorOwner','leaseExpiresAt','updatedAt']) AND NEW.status=CASE WHEN OLD."bodyEtag" IS NULL THEN 'preparing' ELSE 'queued' END AND NEW."attemptToken" IS NULL AND NEW."executorOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL) THEN
   RAISE EXCEPTION 'native restore transition refused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;

 IF (NEW."id",NEW."workspaceId",NEW."targetKind",NEW."targetId",NEW."eventId",NEW."eventSeq",NEW."createdByUserId",NEW."actorCapability",NEW."apiKeyId",NEW."requestFingerprint",NEW."encryptedUrl",NEW."urlHost",NEW."urlFingerprint",NEW."bodyStorageKey",NEW."bodySha256",NEW."bodyByteLength",NEW."inputHash",NEW."expiresAt",NEW."maxAttempts",NEW."createdAt",NEW."deploymentEpoch") IS DISTINCT FROM
    (OLD."id",OLD."workspaceId",OLD."targetKind",OLD."targetId",OLD."eventId",OLD."eventSeq",OLD."createdByUserId",OLD."actorCapability",OLD."apiKeyId",OLD."requestFingerprint",OLD."encryptedUrl",OLD."urlHost",OLD."urlFingerprint",OLD."bodyStorageKey",OLD."bodySha256",OLD."bodyByteLength",OLD."inputHash",OLD."expiresAt",OLD."maxAttempts",OLD."createdAt",OLD."deploymentEpoch") THEN
  RAISE EXCEPTION 'outbound delivery input is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."bodyEtag" IS NOT NULL AND NEW."bodyEtag" IS DISTINCT FROM OLD."bodyEtag" THEN
  RAISE EXCEPTION 'outbound delivery body is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."status" IN ('completed','failed','cancelled') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
  RAISE EXCEPTION 'outbound delivery terminal state is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."generation" IS DISTINCT FROM OLD."generation" AND NOT (NEW."generation"=OLD."generation"+1 AND NEW."status"='queued' AND NEW."attemptToken" IS NULL AND NEW."executorOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL AND NEW."operationDeadlineAt" IS NULL) THEN
  RAISE EXCEPTION 'outbound delivery retry generation is invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;

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
 IF NEW."protectedPrompt" IS DISTINCT FROM OLD."protectedPrompt" AND NOT (OLD."status" IN ('completed','failed','rejected','cancelled') AND OLD."promptExpiresAt"<=CURRENT_TIMESTAMP AND NEW."protectedPrompt"='') THEN
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

CREATE FUNCTION thumbnail_restore_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" AND NOT (
  OLD.status IN ('queued','processing') AND execution_restore_row_allowed(OLD."deploymentEpoch",NEW."deploymentEpoch",'thumbnail_frame',OLD.id,OLD."createdAt")
  AND NEW.generation=OLD.generation+1 AND NEW.status='queued' AND NEW."claimId" IS NULL AND NEW."executorOwner" IS NULL AND NEW."claimExpiresAt" IS NULL AND NEW."validationState" IS NULL
  AND (to_jsonb(NEW)-ARRAY['deploymentEpoch','generation','status','claimId','executorOwner','claimExpiresAt','validationState','updatedAt']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['deploymentEpoch','generation','status','claimId','executorOwner','claimExpiresAt','validationState','updatedAt'])) THEN
   RAISE EXCEPTION 'thumbnail restore transition refused' USING ERRCODE='23514';
 END IF; RETURN NEW; END; $$;
CREATE TRIGGER "ThumbnailFrameOperation_restore_authority" BEFORE UPDATE ON "ThumbnailFrameOperation" FOR EACH ROW EXECUTE FUNCTION thumbnail_restore_authority_guard();
-- Old-epoch walks and accepted future redispatch use separate per-model cursors.
CREATE INDEX "CompletionCallback_maintenance_page_idx" ON "CompletionCallback"("createdAt",id) WHERE state IN ('waiting','pending');
CREATE INDEX "WebhookSubscription_maintenance_page_idx" ON "WebhookSubscription"("createdAt",id) WHERE status='active';

