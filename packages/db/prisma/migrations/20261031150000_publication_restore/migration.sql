-- Restore clears old physical claims before rebinding the same publication intent.
CREATE OR REPLACE FUNCTION social_post_schedule_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."generation" < OLD."generation" OR NEW."scheduleRevision" < OLD."scheduleRevision" OR (NEW."deploymentEpoch" <> OLD."deploymentEpoch" AND NOT (
  NEW."deploymentEpoch">OLD."deploymentEpoch" AND NEW."deploymentEpoch"=(SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1)
  AND NOT EXISTS(SELECT 1 FROM "SocialPublicationAttempt" WHERE "socialPostId"=OLD."id" AND "currentClaimId" IS NOT NULL)
 )) THEN
  RAISE EXCEPTION 'publication execution identity cannot regress' USING ERRCODE='23514';
 END IF;
 IF (NEW."scheduledFor",NEW."caption",NEW."socialAccountId",NEW."immutableRequestHash",NEW."standingGrantId",NEW."standingGrantRevision") IS DISTINCT FROM
    (OLD."scheduledFor",OLD."caption",OLD."socialAccountId",OLD."immutableRequestHash",OLD."standingGrantId",OLD."standingGrantRevision")
    OR (NEW."status" IN ('cancelled','draft') AND NEW."status" IS DISTINCT FROM OLD."status") THEN
  NEW."scheduleRevision" := GREATEST(NEW."scheduleRevision",OLD."scheduleRevision"+1);
  NEW."generation" := GREATEST(NEW."generation",OLD."generation"+1);
 END IF;
 RETURN NEW;
END; $$;

CREATE INDEX "SocialPost_deploymentEpoch_standingGrantId_id_idx" ON "SocialPost"("deploymentEpoch","standingGrantId","id");
CREATE INDEX "SocialPost_deploymentEpoch_id_idx" ON "SocialPost"("deploymentEpoch","id");
CREATE INDEX "FrozenPublicationState_clipExportVariantId_socialPostId_idx" ON "FrozenPublicationState"("clipExportVariantId","socialPostId");
