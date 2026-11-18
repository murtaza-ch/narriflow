-- A sentence-timed dub commits its placed segment timing before its audio.
ALTER TABLE "ClipDub" ADD COLUMN "timingArtifactId" UUID;
CREATE FUNCTION protect_dub_timing() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."timingArtifactId" IS NOT NULL AND NEW."timingArtifactId" IS DISTINCT FROM OLD."timingArtifactId" THEN
    RAISE EXCEPTION 'Dubbing sealed timing is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ClipDub_timing_immutable" BEFORE UPDATE ON "ClipDub" FOR EACH ROW EXECUTE FUNCTION protect_dub_timing();

-- Pre-production: dubs made by the whole-script design are reset, not backfilled.
-- DEPLOY NOTE: apply with dubbing executors drained. A live dubbing run whose
-- dub row disappears would stay live and block every new dub for its project
-- (one live dubbing run per project), so settle those runs first.
UPDATE "WorkflowRun"
SET "status" = 'failed',
    "errorCode" = 'dubbing_reset',
    "leaseOwner" = NULL,
    "leaseExpiresAt" = NULL,
    "nextAttemptAt" = NULL,
    "nextPollAt" = NULL,
    "updatedAt" = NOW()
WHERE "stage" = 'dubbing' AND "status" IN ('queued', 'running', 'waiting');
DELETE FROM "ClipDub";

-- A dub belongs to one editor revision of its clip, so the revision is part of its identity.
ALTER TABLE "ClipDub" ADD COLUMN "editorRevision" INTEGER NOT NULL, ADD COLUMN "videoErrorCode" TEXT;
DROP INDEX "ClipDub_current_tuple_key";
CREATE UNIQUE INDEX "ClipDub_current_tuple_key" ON "ClipDub"("clipId","targetLanguageCode","voice","aspectRatio","editorRevision") WHERE status<>'failed';
DROP INDEX "ClipDub_tuple_history_idx";
CREATE INDEX "ClipDub_tuple_history_idx" ON "ClipDub"("clipId","targetLanguageCode","voice","aspectRatio","editorRevision","createdAt",id);

-- The dub's video is a dub-bound export: ordinary exports have no dubId.
ALTER TABLE "ClipExport" ADD COLUMN "dubId" UUID;
CREATE UNIQUE INDEX "ClipExport_dubId_key" ON "ClipExport"("dubId");
ALTER TABLE "ClipExport" ADD CONSTRAINT "ClipExport_dubId_fkey" FOREIGN KEY ("dubId") REFERENCES "ClipDub"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The capsule trigger no longer guards a dub video artifact, which is gone with the video columns.
CREATE OR REPLACE FUNCTION protect_dub_capsule() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."translationIntentArtifactId" IS NOT NULL AND NEW."translationIntentArtifactId" IS DISTINCT FROM OLD."translationIntentArtifactId" THEN
    RAISE EXCEPTION 'Dubbing paid intent is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD."translationResultArtifactId" IS NOT NULL AND (NEW."translationResultArtifactId",NEW."translatedText") IS DISTINCT FROM (OLD."translationResultArtifactId",OLD."translatedText") THEN
    RAISE EXCEPTION 'Dubbing translation result is immutable' USING ERRCODE='23514';
  END IF;
  IF (OLD."speechIntentArtifactId" IS NOT NULL AND NEW."speechIntentArtifactId" IS DISTINCT FROM OLD."speechIntentArtifactId") OR
    (OLD."audioArtifactId" IS NOT NULL AND NEW."audioArtifactId" IS DISTINCT FROM OLD."audioArtifactId") OR
    (OLD."outcomeArtifactId" IS NOT NULL AND NEW."outcomeArtifactId" IS DISTINCT FROM OLD."outcomeArtifactId") THEN
    RAISE EXCEPTION 'Dubbing speech intent and sealed audio are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" THEN
    IF NOT (NEW."deploymentEpoch">OLD."deploymentEpoch" AND EXISTS(SELECT 1 FROM "ExecutionEpoch" WHERE id=1 AND epoch=NEW."deploymentEpoch" AND NOT "admissionOpen")
      AND OLD.status::text IN ('queued','processing') AND NEW.status::text='queued'
      AND num_nonnulls(NEW."inputBindingHash",NEW."inputStorageKey",NEW."inputEtag",NEW."inputByteLength",NEW."inputChecksumSha256")=0
      AND EXISTS(SELECT 1 FROM "WorkflowRun" WHERE id=NEW."workflowRunId" AND "deploymentEpoch"=NEW."deploymentEpoch" AND status='queued' AND "attemptId" IS NULL AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)) THEN
      RAISE EXCEPTION 'Dubbing capsule epoch changes only during quiesced restore' USING ERRCODE='23514';
    END IF;
  ELSIF OLD."inputStorageKey" IS NOT NULL AND (NEW."inputBindingHash",NEW."inputStorageKey",NEW."inputEtag",NEW."inputByteLength",NEW."inputChecksumSha256") IS DISTINCT FROM
    (OLD."inputBindingHash",OLD."inputStorageKey",OLD."inputEtag",OLD."inputByteLength",OLD."inputChecksumSha256") THEN
    RAISE EXCEPTION 'Dubbing capsule is immutable within its epoch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE "ClipDub" DROP COLUMN "renderStorageKey", DROP COLUMN "renderSizeBytes", DROP COLUMN "videoArtifactId";
