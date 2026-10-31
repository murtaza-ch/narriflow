-- Unpublished validation pairs belong to one physical owner. A qualified
-- restore clears their pointers, preserving all committed artifact/start history.
CREATE OR REPLACE FUNCTION native_validation_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" THEN
  IF NOT (OLD.status::text IN ('queued','processing','running','waiting','preparing') AND execution_restore_row_allowed(OLD."deploymentEpoch",NEW."deploymentEpoch",'native_validation',OLD.id,OLD."createdAt")
   AND NEW.generation=OLD.generation+1 AND (to_jsonb(NEW)-ARRAY['deploymentEpoch','generation','inputHash','status','attemptToken','executorOwner','leaseExpiresAt','updatedAt','result']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['deploymentEpoch','generation','inputHash','status','attemptToken','executorOwner','leaseExpiresAt','updatedAt','result']) AND NEW."result" IS NULL AND NEW.status='queued' AND NEW."attemptToken" IS NULL AND NEW."executorOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL) THEN
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
