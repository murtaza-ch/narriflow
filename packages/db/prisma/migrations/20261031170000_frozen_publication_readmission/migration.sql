-- Retired approvals retain their original Post's purge ownership and immutable
-- attempt snapshots while a fresh explicit approval attaches a new snapshot.
ALTER TABLE "FrozenPublicationState" ALTER COLUMN "socialPostId" DROP NOT NULL,
 ADD COLUMN "retiredForPostId" UUID,
 ADD COLUMN "confirmedScheduleRevision" INTEGER;
ALTER TABLE "FrozenPublicationState" ADD CONSTRAINT "FrozenPublicationState_retiredForPostId_fkey"
 FOREIGN KEY ("retiredForPostId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FrozenPublicationState" ADD CONSTRAINT "FrozenPublicationState_owner_shape" CHECK (
 (("socialPostId" IS NOT NULL)::integer+("retiredForPostId" IS NOT NULL)::integer)=1
 AND ("confirmedScheduleRevision" IS NULL OR "confirmedScheduleRevision">0)
);
CREATE INDEX "FrozenPublicationState_retired_confirmation_idx"
 ON "FrozenPublicationState"("retiredForPostId","confirmedScheduleRevision");
CREATE UNIQUE INDEX "FrozenPublicationState_approval_identity"
 ON "FrozenPublicationState"((COALESCE("socialPostId","retiredForPostId")),"confirmedScheduleRevision") WHERE "confirmedScheduleRevision" IS NOT NULL;
CREATE OR REPLACE FUNCTION frozen_publication_state_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE detaching boolean;
BEGIN
 detaching := OLD."socialPostId" IS NOT NULL AND NEW."socialPostId" IS NULL AND OLD."retiredForPostId" IS NULL AND NEW."retiredForPostId"=OLD."socialPostId";
 IF detaching THEN
  IF (to_jsonb(NEW)-ARRAY['socialPostId','retiredForPostId']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['socialPostId','retiredForPostId'])
   OR NOT EXISTS(SELECT 1 FROM "SocialPost" p WHERE p."id"=OLD."socialPostId" AND p."status"='draft')
   OR EXISTS(SELECT 1 FROM "SocialPublicationAttempt" a WHERE a."frozenStateId"=OLD."id" AND
    (a."phase"<>'failed' OR a."terminalAt" IS NULL OR a."currentClaimId" IS NOT NULL OR a."providerCallCount">0 OR a."operationKind" IS NOT NULL OR a."checkpointEncrypted" IS NOT NULL
     OR EXISTS(SELECT 1 FROM "ProviderReceipt" r WHERE r."attemptId"=a."id")
     OR EXISTS(SELECT 1 FROM "PublicationClaim" c WHERE c."attemptId"=a."id" AND (
      c."releasedAt" IS NULL OR c."accountSlotKey" IS NOT NULL
      OR c."workState"->'providerGrant' IS NOT NULL AND c."workState"->'providerGrant'<>'null'::jsonb
      OR c."workState"->'irreversibleGrants' IS NOT NULL AND c."workState"->'irreversibleGrants'<>'[]'::jsonb
      OR EXISTS(SELECT 1 FROM "ExecutionAttempt" e WHERE e."attemptToken"=c."id" AND e."status" IN ('queued','owned','running'))
     )))) THEN
   RAISE EXCEPTION 'only a revoked, provably unstarted approval may retire' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['storageKey','sizeBytes','durationSec','mediaReadyAt']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['storageKey','sizeBytes','durationSec','mediaReadyAt']) THEN
   RAISE EXCEPTION 'frozen publication intent is immutable' USING ERRCODE='23514';
  END IF;
  IF (NEW."storageKey",NEW."sizeBytes",NEW."durationSec",NEW."mediaReadyAt") IS DISTINCT FROM
     (OLD."storageKey",OLD."sizeBytes",OLD."durationSec",OLD."mediaReadyAt") AND NOT (
     OLD."storageKey" IS NULL AND OLD."sizeBytes" IS NULL AND OLD."durationSec" IS NULL AND OLD."mediaReadyAt" IS NULL
     AND NEW."storageKey" IS NOT NULL AND NEW."sizeBytes">0 AND NEW."durationSec">0 AND NEW."mediaReadyAt" IS NOT NULL) THEN
   RAISE EXCEPTION 'frozen publication media is already sealed' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION frozen_publication_state_attached_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."socialPostId" IS NULL OR NEW."retiredForPostId" IS NOT NULL THEN
  RAISE EXCEPTION 'a retired approval must first have been attached' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "FrozenPublicationState_attached_insert" BEFORE INSERT ON "FrozenPublicationState"
 FOR EACH ROW EXECUTE FUNCTION frozen_publication_state_attached_insert();
