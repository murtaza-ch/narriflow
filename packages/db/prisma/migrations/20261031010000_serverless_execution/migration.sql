-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "sourceRevision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN     "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "operationDeadlineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RenderGroup" ADD COLUMN     "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "operationDeadlineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Transcript" ADD COLUMN     "providerResultDeadlineAt" TIMESTAMP(3),
ADD COLUMN     "providerSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "selectionGeneration" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sourceAudioId" UUID,
ADD COLUMN     "sourceRevision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "IngestJob" ADD COLUMN     "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "executorOwner" UUID,
ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "operationDeadlineAt" TIMESTAMP(3),
ADD COLUMN     "sourceRevision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "SocialPost" ADD COLUMN     "scheduleRevision" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "ExecutionEpoch" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "admissionOpen" BOOLEAN NOT NULL DEFAULT false,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionEpoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionDispatch" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "subjectKind" VARCHAR(40) NOT NULL,
    "subjectId" VARCHAR(160) NOT NULL,
    "generation" INTEGER NOT NULL,
    "deploymentEpoch" INTEGER NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "deliveryKey" VARCHAR(100) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "nextDeliveryAt" TIMESTAMP(3) NOT NULL,
    "deliveryToken" UUID,
    "deliveryLeaseExpiresAt" TIMESTAMP(3),
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "acknowledgedAt" TIMESTAMP(3),
    "destinationId" VARCHAR(160),
    "wakeKind" VARCHAR(40),
    "deadlineKind" VARCHAR(32),
    "observedDeadlineAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "errorCode" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionAttempt" (
    "attemptToken" UUID NOT NULL,
    "dispatchId" UUID NOT NULL,
    "deploymentEpoch" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "functionName" VARCHAR(40) NOT NULL,
    "owner" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "operationDeadlineAt" TIMESTAMP(3) NOT NULL,
    "processStartedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "status" VARCHAR(24) NOT NULL DEFAULT 'admitted',
    "failureCode" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionAttempt_pkey" PRIMARY KEY ("attemptToken")
);

-- CreateTable
CREATE TABLE "ExecutionInboxReceipt" (
    "audience" VARCHAR(32) NOT NULL,
    "deliveryId" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "keyId" VARCHAR(64) NOT NULL,
    "disposition" JSONB NOT NULL,
    "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionInboxReceipt_pkey" PRIMARY KEY ("audience","deliveryId")
);

-- CreateTable
CREATE TABLE "ExecutionArtifact" (
    "id" UUID NOT NULL,
    "attemptToken" UUID NOT NULL,
    "owner" UUID NOT NULL,
    "role" VARCHAR(32) NOT NULL,
    "bindingHash" CHAR(64) NOT NULL,
    "storageKey" VARCHAR(1024) NOT NULL,
    "contentType" VARCHAR(128) NOT NULL,
    "maxBytes" BIGINT NOT NULL,
    "byteLength" BIGINT,
    "checksumSha256" CHAR(64),
    "etag" VARCHAR(160),
    "multipartUploadId" VARCHAR(1024),
    "sourceEtag" VARCHAR(160),
    "sourceByteLength" BIGINT,
    "sourceVideoBinding" JSONB,
    "uploadByteLength" BIGINT,
    "multipartPartChecksums" JSONB,
    "multipartCompleteIntentAt" TIMESTAMP(3),
    "multipartAbortIntentAt" TIMESTAMP(3),
    "grantExpiresAt" TIMESTAMP(3) NOT NULL,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceAudio" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "mediaProvider" VARCHAR(16) NOT NULL,
    "mediaId" VARCHAR(160) NOT NULL,
    "audioTrack" JSONB NOT NULL,
    "bindingHash" CHAR(64) NOT NULL,
    "storageKey" VARCHAR(1024) NOT NULL,
    "etag" VARCHAR(160) NOT NULL,
    "byteLength" BIGINT NOT NULL,
    "checksumSha256" CHAR(64) NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "audioStartTimeSec" DOUBLE PRECISION NOT NULL,
    "probeVersion" VARCHAR(160) NOT NULL,
    "toolchainFingerprint" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceAudio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceRefundNeed" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "sourceAudioId" UUID NOT NULL,
    "sourceAudioBindingHash" CHAR(64) NOT NULL,
    "videoBindingHash" CHAR(64) NOT NULL,
    "failureCode" VARCHAR(100) NOT NULL DEFAULT 'source_audio_video_mismatch',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceRefundNeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipSelectionWindow" (
    "id" UUID NOT NULL,
    "transcriptId" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "windowIndex" INTEGER NOT NULL,
    "startSec" DOUBLE PRECISION NOT NULL,
    "endSec" DOUBLE PRECISION NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "resultStorageKey" VARCHAR(1024),
    "resultHash" CHAR(64),
    "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "retryAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipSelectionWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionDispatch_deliveryKey_key" ON "ExecutionDispatch"("deliveryKey");

-- CreateIndex
CREATE INDEX "ExecutionDispatch_acknowledgedAt_deadLetteredAt_nextDeliver_idx" ON "ExecutionDispatch"("acknowledgedAt", "deadLetteredAt", "nextDeliveryAt", "deliveryLeaseExpiresAt");

-- CreateIndex
CREATE INDEX "ExecutionDispatch_deploymentEpoch_subjectKind_subjectId_gen_idx" ON "ExecutionDispatch"("deploymentEpoch", "subjectKind", "subjectId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionDispatch_id_deploymentEpoch_generation_inputHash_key" ON "ExecutionDispatch"("id", "deploymentEpoch", "generation", "inputHash");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_status_leaseExpiresAt_idx" ON "ExecutionAttempt"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_status_operationDeadlineAt_idx" ON "ExecutionAttempt"("status", "operationDeadlineAt");

-- CreateIndex
CREATE INDEX "ExecutionInboxReceipt_expiresAt_idx" ON "ExecutionInboxReceipt"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionArtifact_storageKey_key" ON "ExecutionArtifact"("storageKey");

-- CreateIndex
CREATE INDEX "ExecutionArtifact_committedAt_grantExpiresAt_idx" ON "ExecutionArtifact"("committedAt", "grantExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionArtifact_attemptToken_owner_role_bindingHash_key" ON "ExecutionArtifact"("attemptToken", "owner", "role", "bindingHash");

-- CreateIndex
CREATE UNIQUE INDEX "SourceAudio_storageKey_key" ON "SourceAudio"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "SourceAudio_projectId_sourceRevision_key" ON "SourceAudio"("projectId", "sourceRevision");

-- CreateIndex
CREATE UNIQUE INDEX "SourceAudio_id_projectId_sourceRevision_key" ON "SourceAudio"("id", "projectId", "sourceRevision");

-- CreateIndex
CREATE INDEX "SourceRefundNeed_resolvedAt_createdAt_idx" ON "SourceRefundNeed"("resolvedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRefundNeed_projectId_sourceRevision_key" ON "SourceRefundNeed"("projectId", "sourceRevision");

-- CreateIndex
CREATE INDEX "ClipSelectionWindow_status_retryAt_idx" ON "ClipSelectionWindow"("status", "retryAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClipSelectionWindow_transcriptId_generation_windowIndex_key" ON "ClipSelectionWindow"("transcriptId", "generation", "windowIndex");

-- CreateIndex
CREATE INDEX "Transcript_status_providerSubmissionDeadlineAt_idx" ON "Transcript"("status", "providerSubmissionDeadlineAt");

-- CreateIndex
CREATE INDEX "Transcript_status_providerResultDeadlineAt_idx" ON "Transcript"("status", "providerResultDeadlineAt");

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_sourceAudioId_projectId_sourceRevision_fkey" FOREIGN KEY ("sourceAudioId", "projectId", "sourceRevision") REFERENCES "SourceAudio"("id", "projectId", "sourceRevision") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_dispatchId_deploymentEpoch_generation_inp_fkey" FOREIGN KEY ("dispatchId", "deploymentEpoch", "generation", "inputHash") REFERENCES "ExecutionDispatch"("id", "deploymentEpoch", "generation", "inputHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExecutionArtifact" ADD CONSTRAINT "ExecutionArtifact_attemptToken_fkey" FOREIGN KEY ("attemptToken") REFERENCES "ExecutionAttempt"("attemptToken") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceAudio" ADD CONSTRAINT "SourceAudio_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipSelectionWindow" ADD CONSTRAINT "ClipSelectionWindow_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Domain invariants that Prisma cannot express. Delivery retries never allocate domain attempts.
ALTER TABLE "ExecutionEpoch" ADD CONSTRAINT "ExecutionEpoch_singleton_check"
  CHECK ("id" = 1 AND "epoch" > 0);
INSERT INTO "ExecutionEpoch" ("id", "epoch", "admissionOpen") VALUES (1, 1, false);

ALTER TABLE "ExecutionDispatch" ADD CONSTRAINT "ExecutionDispatch_reference_check" CHECK (
  "generation" > 0 AND "deploymentEpoch" > 0 AND "inputHash" ~ '^[a-f0-9]{64}$'
  AND "subjectId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  AND "kind" IN ('import_pipeline','render_run','operation_driver','maintenance','project_progress','local_fetch','modal_execution')
  AND "subjectKind" IN ('ingest_job','workflow_run','render_group','clip_preparation','upload_session','social_publication','completion_callback','webhook_subscription','workspace_billing','autopilot_rule','generation_finishing','dubbing','export_bundle','generated_media','thumbnail_frame','native_validation','outbound_probe','library_index','notification','media_cleanup','workflow_event','workspace_event','standing_grant','pending_workspace','retention','maintenance')
  AND "deliveryAttempts" >= 0
  AND (("deliveryToken" IS NULL) = ("deliveryLeaseExpiresAt" IS NULL))
  AND NOT ("acknowledgedAt" IS NOT NULL AND "deadLetteredAt" IS NOT NULL)
  AND (("deadlineKind" IS NULL) = ("observedDeadlineAt" IS NULL))
  AND ("deadlineKind" IS NULL OR "deadlineKind" IN ('lease','operation','provider_submission','provider_result','retry'))
);
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_authority_check" CHECK (
  "deploymentEpoch" > 0 AND "generation" > 0 AND "inputHash" ~ '^[a-f0-9]{64}$'
  AND "status" IN ('admitted','running','completed','failed','released','cancelled','expired','superseded')
  AND "operationDeadlineAt" > "createdAt"
  AND (("owner" IS NULL) = ("leaseExpiresAt" IS NULL))
  AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= "operationDeadlineAt")
  AND ("processStartedAt" IS NULL OR "owner" IS NOT NULL)
  AND ("status" <> 'running' OR ("owner" IS NOT NULL AND "processStartedAt" IS NOT NULL))
  AND ("status" IN ('admitted','running') OR "finishedAt" IS NOT NULL)
);
ALTER TABLE "ExecutionInboxReceipt" ADD CONSTRAINT "ExecutionInboxReceipt_bounded_check" CHECK (
  "audience" IN ('modal-bridge','executor-control','dev-device','watchdog')
  AND "requestHash" ~ '^[a-f0-9]{64}$' AND octet_length("disposition"::text) <= 65536
  AND "expiresAt" > "committedAt"
);
ALTER TABLE "ExecutionArtifact" ADD CONSTRAINT "ExecutionArtifact_identity_check" CHECK (
  "maxBytes" > 0 AND "maxBytes" <= 10737418240
  AND ("byteLength" IS NULL OR ("byteLength" > 0 AND "byteLength" <= "maxBytes"))
  AND "bindingHash" ~ '^[a-f0-9]{64}$'
  AND ("checksumSha256" IS NULL OR "checksumSha256" ~ '^[a-f0-9]{64}$')
  AND "storageKey" ~ '^[A-Za-z0-9][A-Za-z0-9/_.-]*$'
  AND "storageKey" !~ '(^|/)\.{1,2}(/|$)' AND "storageKey" NOT LIKE '%//%'
  AND "grantExpiresAt" > "createdAt"
  AND ("committedAt" IS NULL OR ("byteLength" IS NOT NULL AND "checksumSha256" IS NOT NULL AND "etag" IS NOT NULL))
);
ALTER TABLE "SourceAudio" ADD CONSTRAINT "SourceAudio_whole_source_check" CHECK (
  "sourceRevision" > 0 AND "byteLength" > 0 AND "byteLength" <= 10737418240
  AND "durationSeconds" > 0 AND "durationSeconds" < 'Infinity'::float8
  AND "audioStartTimeSec" > '-Infinity'::float8 AND "audioStartTimeSec" < 'Infinity'::float8
  AND "mediaProvider" IN ('youtube','upload','rss','direct','drive','zoom')
  AND "bindingHash" ~ '^[a-f0-9]{64}$' AND "checksumSha256" ~ '^[a-f0-9]{64}$'
  AND "toolchainFingerprint" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("audioTrack") = 'object'
);
ALTER TABLE "SourceRefundNeed" ADD CONSTRAINT "SourceRefundNeed_binding_check" CHECK (
  "sourceRevision" > 0 AND "sourceAudioBindingHash" ~ '^[a-f0-9]{64}$' AND "videoBindingHash" ~ '^[a-f0-9]{64}$'
);
ALTER TABLE "ClipSelectionWindow" ADD CONSTRAINT "ClipSelectionWindow_bounds_check" CHECK (
  "generation" > 0 AND "windowIndex" >= 0 AND "startSec" >= 0 AND "endSec" > "startSec"
  AND "endSec" < 'Infinity'::float8 AND "inputHash" ~ '^[a-f0-9]{64}$'
  AND "status" IN ('queued','running','completed','failed')
  AND ("status" <> 'completed' OR ("resultStorageKey" IS NOT NULL AND "resultHash" IS NOT NULL AND "resultHash" ~ '^[a-f0-9]{64}$' AND "completedAt" IS NOT NULL))
);

-- Evidence is append-only. A source replacement allocates a new Project source revision.
CREATE FUNCTION reject_source_audio_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Source Audio evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "SourceAudio_immutable" BEFORE UPDATE ON "SourceAudio"
  FOR EACH ROW EXECUTE FUNCTION reject_source_audio_update();

-- Preserve current waiting identity while removing updatedAt as the timeout clock.
UPDATE "Transcript" SET "providerSubmittedAt" = "updatedAt",
  "providerResultDeadlineAt" = "updatedAt" + INTERVAL '2 hours'
WHERE "status" = 'processing' AND ("providerJobId" IS NOT NULL OR "providerRequestId" IS NOT NULL);


-- Future work registers its scheduler immediately; nextDeliveryAt is independent of dueAt.
CREATE INDEX "ExecutionDispatch_pending_epoch_due_idx"
  ON "ExecutionDispatch" ("deploymentEpoch", "nextDeliveryAt", "id")
  WHERE "acknowledgedAt" IS NULL AND "deadLetteredAt" IS NULL;

ALTER TABLE "WorkflowEvent" RENAME COLUMN "redisRequired" TO "progressRequired";
ALTER TABLE "WorkflowEvent" RENAME COLUMN "redisPublishedAt" TO "progressPublishedAt";
ALTER TABLE "Project" ADD CONSTRAINT "Project_source_revision_check" CHECK ("sourceRevision" > 0);
CREATE INDEX "WorkflowRun_source_cancellation_page_idx" ON "WorkflowRun"("projectId","deploymentEpoch","status","errorCode","updatedAt","id");
CREATE INDEX "RenderGroup_source_cancellation_page_idx" ON "RenderGroup"("workflowRunId","deploymentEpoch","status","errorCode","updatedAt","id");
CREATE INDEX "WorkflowRun_scribe_capacity_wait_idx" ON "WorkflowRun"("deploymentEpoch","createdAt","id")
  WHERE "stage"='stt' AND "status"='queued' AND "errorCode"='provider_capacity_wait';
CREATE INDEX "ExecutionAttempt_dispatchId_idx" ON "ExecutionAttempt"("dispatchId");
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_execution_revision_check" CHECK ("deploymentEpoch" > 0 AND "generation" > 0);
ALTER TABLE "RenderGroup" ADD CONSTRAINT "RenderGroup_execution_revision_check" CHECK ("deploymentEpoch" > 0 AND "generation" > 0);
ALTER TABLE "IngestJob" ADD CONSTRAINT "IngestJob_execution_revision_check" CHECK ("deploymentEpoch" > 0 AND "generation" > 0 AND "sourceRevision" > 0);
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_schedule_revision_check" CHECK ("scheduleRevision" > 0);

-- Dev-only passcodes are reset without making protected rounds accessible.
-- Revoke first in the same statement; review audits and recipient history remain.
UPDATE "ReviewRound" SET "revokedAt" = COALESCE("revokedAt", now()), "passcodeHash" = NULL
  WHERE "passcodeHash" IS NOT NULL;

ALTER TABLE "ExecutionAttempt" ADD COLUMN "inputStorageKey" VARCHAR(1024), ADD COLUMN "inputEtag" VARCHAR(160), ADD COLUMN "inputByteLength" BIGINT, ADD COLUMN "inputChecksumSha256" CHAR(64);
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_input_binding_check" CHECK (
  ("inputStorageKey" IS NULL AND "inputEtag" IS NULL AND "inputByteLength" IS NULL AND "inputChecksumSha256" IS NULL)
  OR ("inputStorageKey" IS NOT NULL AND "inputEtag" IS NOT NULL AND "inputByteLength" IS NOT NULL AND "inputByteLength" > 0 AND "inputByteLength" <= 16777216
    AND "inputChecksumSha256" IS NOT NULL AND "inputChecksumSha256" ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION execution_attempt_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."attemptToken",NEW."dispatchId",NEW."deploymentEpoch",NEW."generation",NEW."inputHash",NEW."functionName",NEW."operationDeadlineAt",NEW."createdAt")
     IS DISTINCT FROM
     (OLD."attemptToken",OLD."dispatchId",OLD."deploymentEpoch",OLD."generation",OLD."inputHash",OLD."functionName",OLD."operationDeadlineAt",OLD."createdAt") THEN
    RAISE EXCEPTION 'execution attempt identity is immutable' USING ERRCODE='23514';
  END IF;
  IF (NEW."inputStorageKey",NEW."inputEtag",NEW."inputByteLength",NEW."inputChecksumSha256") IS DISTINCT FROM
     (OLD."inputStorageKey",OLD."inputEtag",OLD."inputByteLength",OLD."inputChecksumSha256") AND
     (OLD."inputStorageKey" IS NOT NULL OR OLD."owner" IS NOT NULL OR OLD."processStartedAt" IS NOT NULL OR OLD."status" <> 'admitted') THEN
    RAISE EXCEPTION 'execution input bytes are immutable before acquisition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ExecutionAttempt_identity_immutable" BEFORE UPDATE ON "ExecutionAttempt"
FOR EACH ROW EXECUTE FUNCTION execution_attempt_identity_immutable();
ALTER TABLE "ExecutionInboxReceipt" ADD COLUMN "wakeDispatchIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
ALTER TABLE "ExecutionInboxReceipt" ADD CONSTRAINT "ExecutionInboxReceipt_wake_bound_check" CHECK (cardinality("wakeDispatchIds") <= 128);
CREATE OR REPLACE FUNCTION render_group_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','attemptToken','leaseOwner','leaseExpiresAt','heartbeatAt','nextAttemptAt',
      'chargedAttemptCount','errorCode','failureDisposition','settledAt','updatedAt','generation','deploymentEpoch','operationDeadlineAt'])
    IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','attemptToken','leaseOwner','leaseExpiresAt','heartbeatAt','nextAttemptAt',
      'chargedAttemptCount','errorCode','failureDisposition','settledAt','updatedAt','generation','deploymentEpoch','operationDeadlineAt']) THEN
    RAISE EXCEPTION 'render group identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."generation" IS DISTINCT FROM OLD."generation" AND NOT (
    NEW."generation" = OLD."generation" + 1 AND OLD."status" IN ('queued','running') AND NEW."status"='queued'
    AND NEW."attemptToken" IS NULL AND NEW."leaseOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'render group generation advances only on fenced requeue' USING ERRCODE='23514';
  END IF;
  IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" AND NOT (
    NEW."deploymentEpoch" > OLD."deploymentEpoch" AND NEW."deploymentEpoch"=(SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1)
    AND OLD."status" IN ('queued','running') AND NEW."status"='queued'
    AND NEW."attemptToken" IS NULL AND NEW."leaseOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'render group epoch changes only during fenced restore' USING ERRCODE='23514';
  END IF;
  IF NEW."operationDeadlineAt" IS DISTINCT FROM OLD."operationDeadlineAt" AND NOT (
    NEW."operationDeadlineAt" IS NOT NULL AND (
      (OLD."operationDeadlineAt" IS NULL AND NEW."status" IN ('queued','running')) OR
      (NEW."deploymentEpoch" > OLD."deploymentEpoch" AND NEW."status"='queued'
       AND NEW."attemptToken" IS NULL AND NEW."leaseOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL)
    )
  ) THEN
    RAISE EXCEPTION 'render group operation deadline is immutable within its epoch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- A complete video may arrive before its whole-source audio. Retain its sealed
-- evidence for the audio callback without making the Project video-ready.
ALTER TABLE "ExecutionArtifact" ADD CONSTRAINT "ExecutionArtifact_video_evidence_check" CHECK (
  "sourceVideoBinding" IS NULL OR ("role" = 'source_video'
    AND jsonb_typeof("sourceVideoBinding") = 'object'
    AND octet_length("sourceVideoBinding"::text) <= 65536)
);
CREATE FUNCTION execution_artifact_sealed_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."committedAt" IS NOT NULL AND
     (to_jsonb(NEW) - 'grantExpiresAt') IS DISTINCT FROM (to_jsonb(OLD) - 'grantExpiresAt') THEN
    RAISE EXCEPTION 'committed execution artifact evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ExecutionArtifact_sealed_evidence" BEFORE UPDATE ON "ExecutionArtifact"
FOR EACH ROW EXECUTE FUNCTION execution_artifact_sealed_evidence();

-- Compact per-part tuples [byteLength, MD5-base64, measured-SHA256-base64].
-- Index is partNumber-1. Native callers never send a 640-part completion body.
ALTER TABLE "ExecutionArtifact" ADD CONSTRAINT "ExecutionArtifact_upload_plan_check" CHECK (
  ("uploadByteLength" IS NULL OR ("uploadByteLength" > 0 AND "uploadByteLength" <= "maxBytes"))
  AND ("multipartPartChecksums" IS NULL OR ("uploadByteLength" IS NOT NULL
    AND jsonb_typeof("multipartPartChecksums") = 'array'
    AND jsonb_array_length("multipartPartChecksums") <= 640
    AND octet_length("multipartPartChecksums"::text) <= 65536))
  AND NOT ("multipartCompleteIntentAt" IS NOT NULL AND "multipartAbortIntentAt" IS NOT NULL)
  AND ("multipartCompleteIntentAt" IS NULL OR ("uploadByteLength" IS NOT NULL
    AND "multipartUploadId" IS NOT NULL AND "checksumSha256" IS NOT NULL))
);
CREATE FUNCTION execution_artifact_transfer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item jsonb;
  position bigint;
  expected bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."attemptToken", NEW."owner", NEW."role", NEW."bindingHash", NEW."storageKey", NEW."maxBytes", NEW."sourceEtag", NEW."sourceByteLength", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."id", OLD."attemptToken", OLD."owner", OLD."role", OLD."bindingHash", OLD."storageKey", OLD."maxBytes", OLD."sourceEtag", OLD."sourceByteLength", OLD."createdAt") THEN
      RAISE EXCEPTION 'execution artifact assignment is immutable' USING ERRCODE='23514';
    END IF;
    IF (OLD."uploadByteLength" IS NOT NULL AND (NEW."uploadByteLength", NEW."contentType") IS DISTINCT FROM (OLD."uploadByteLength", OLD."contentType"))
       OR (OLD."multipartUploadId" IS NOT NULL AND NEW."multipartUploadId" IS DISTINCT FROM OLD."multipartUploadId")
       OR (OLD."multipartCompleteIntentAt" IS NOT NULL AND (NEW."multipartCompleteIntentAt", NEW."checksumSha256") IS DISTINCT FROM (OLD."multipartCompleteIntentAt", OLD."checksumSha256"))
       OR (OLD."multipartAbortIntentAt" IS NOT NULL AND NEW."multipartAbortIntentAt" IS DISTINCT FROM OLD."multipartAbortIntentAt") THEN
      RAISE EXCEPTION 'execution multipart intent is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD."multipartPartChecksums" IS NOT NULL THEN
      FOR item, position IN SELECT value, ordinality FROM jsonb_array_elements(OLD."multipartPartChecksums") WITH ORDINALITY LOOP
        IF item <> 'null'::jsonb AND item IS DISTINCT FROM NEW."multipartPartChecksums" -> (position::int - 1) THEN
          RAISE EXCEPTION 'granted part checksums are immutable' USING ERRCODE='23514';
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF NEW."multipartPartChecksums" IS NOT NULL THEN
    FOR item, position IN SELECT value, ordinality FROM jsonb_array_elements(NEW."multipartPartChecksums") WITH ORDINALITY LOOP
      expected := LEAST(16777216, NEW."uploadByteLength" - (position - 1) * 16777216);
      IF item <> 'null'::jsonb AND (jsonb_typeof(item) <> 'array' OR jsonb_array_length(item) <> 3
         OR jsonb_typeof(item -> 0) <> 'number' OR (item ->> 0)::bigint IS DISTINCT FROM expected OR expected <= 0
         OR jsonb_typeof(item -> 1) IS DISTINCT FROM 'string' OR jsonb_typeof(item -> 2) IS DISTINCT FROM 'string'
         OR (item ->> 1) !~ '^[A-Za-z0-9+/]{22}==$' OR (item ->> 2) !~ '^[A-Za-z0-9+/]{43}=$') THEN
        RAISE EXCEPTION 'execution multipart plan is invalid' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ExecutionArtifact_transfer_identity" BEFORE INSERT OR UPDATE ON "ExecutionArtifact"
FOR EACH ROW EXECUTE FUNCTION execution_artifact_transfer_identity();

-- Native validation replaces synchronous font/asset parsing on Workers.
-- AlterTable
ALTER TABLE "ThumbnailFrameOperation" ADD COLUMN     "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "executorOwner" UUID,
ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "operationDeadlineAt" TIMESTAMP(3),
ADD COLUMN     "validationState" JSONB;

-- AlterTable
ALTER TABLE "BrandFont" ADD COLUMN     "face" JSONB;

-- CreateTable
CREATE TABLE "NativeValidationJob" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "ownerUserId" UUID,
    "ownerWorkspaceId" UUID,
    "kind" VARCHAR(24) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "input" JSONB NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "inputStorageKey" VARCHAR(1024) NOT NULL,
    "inputEtag" VARCHAR(160) NOT NULL,
    "inputByteLength" BIGINT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "deploymentEpoch" INTEGER NOT NULL,
    "attemptToken" UUID,
    "executorOwner" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "operationDeadlineAt" TIMESTAMP(3) NOT NULL,
    "chargedAttempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "retryAt" TIMESTAMP(3),
    "result" JSONB,
    "errorCode" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "NativeValidationJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NativeValidationJob_status_retryAt_createdAt_idx" ON "NativeValidationJob"("status", "retryAt", "createdAt");

-- CreateIndex
CREATE INDEX "NativeValidationJob_workspaceId_createdAt_idx" ON "NativeValidationJob"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeValidationJob_workspaceId_kind_requestFingerprint_key" ON "NativeValidationJob"("workspaceId", "kind", "requestFingerprint");


ALTER TABLE "NativeValidationJob" ADD CONSTRAINT "NativeValidationJob_authority_check" CHECK (
  num_nonnulls("ownerUserId", "ownerWorkspaceId") = 1
  AND "kind" IN ('brand_font','visual_asset')
  AND "requestFingerprint" ~ '^[a-f0-9]{64}$' AND "inputHash" ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof("input") = 'object' AND octet_length("input"::text) <= 65536
  AND ("result" IS NULL OR (jsonb_typeof("result") = 'object' AND octet_length("result"::text) <= 65536))
  AND "inputByteLength" > 0 AND "inputByteLength" <= 2147483648
  AND "generation" > 0 AND "deploymentEpoch" > 0
  AND "status" IN ('queued','processing','completed','failed','cancelled')
  AND "chargedAttempts" >= 0 AND "maxAttempts" BETWEEN 1 AND 10 AND "chargedAttempts" <= "maxAttempts"
  AND "operationDeadlineAt" > "createdAt"
  AND (("executorOwner" IS NULL) = ("leaseExpiresAt" IS NULL))
  AND ("executorOwner" IS NULL OR "attemptToken" IS NOT NULL)
  AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= "operationDeadlineAt")
  AND ("status" <> 'processing' OR "executorOwner" IS NOT NULL)
  AND ("status" NOT IN ('completed','failed','cancelled') OR "completedAt" IS NOT NULL)
  AND ("status" <> 'completed' OR "result" IS NOT NULL)
);
CREATE FUNCTION native_validation_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER "NativeValidationJob_input_immutable" BEFORE UPDATE ON "NativeValidationJob"
FOR EACH ROW EXECUTE FUNCTION native_validation_input_immutable();

-- Old native thumbnail claims cannot authorize the new executor contract.
UPDATE "ThumbnailFrameOperation" SET "status"='failed',"errorCode"='serverless_cutover_reset',"completedAt"=CURRENT_TIMESTAMP,"claimId"=NULL,"claimExpiresAt"=NULL
WHERE "status" IN ('queued','processing');
UPDATE "ThumbnailFrameOperation" SET "claimId"=NULL,"claimExpiresAt"=NULL WHERE "claimId" IS NOT NULL;
ALTER TABLE "ThumbnailFrameOperation" ADD CONSTRAINT "ThumbnailFrameOperation_execution_check" CHECK (
  "generation" > 0 AND "deploymentEpoch" > 0 AND "attempt" >= 0
  AND ("validationState" IS NULL OR (jsonb_typeof("validationState") = 'object' AND octet_length("validationState"::text) <= 65536))
  AND (("executorOwner" IS NULL) = ("claimExpiresAt" IS NULL))
  AND ("executorOwner" IS NULL OR "claimId" IS NOT NULL)
  AND ("operationDeadlineAt" IS NULL OR "operationDeadlineAt" > "createdAt")
  AND ("status" NOT IN ('queued','processing') OR "operationDeadlineAt" IS NOT NULL)
  AND ("status" <> 'processing' OR "executorOwner" IS NOT NULL)
);


CREATE TABLE "OutboundProbe" (
 "id" UUID PRIMARY KEY, "workspaceId" UUID NOT NULL, "createdByUserId" UUID NOT NULL,
 "kind" VARCHAR(24) NOT NULL, "requestFingerprint" CHAR(64) NOT NULL, "input" JSONB NOT NULL, "inputHash" CHAR(64) NOT NULL,
 "status" VARCHAR(24) NOT NULL DEFAULT 'queued', "generation" INTEGER NOT NULL DEFAULT 1, "deploymentEpoch" INTEGER NOT NULL,
 "attemptToken" UUID, "executorOwner" UUID, "leaseExpiresAt" TIMESTAMP(3), "operationDeadlineAt" TIMESTAMP(3) NOT NULL,
 "chargedAttempts" INTEGER NOT NULL DEFAULT 0, "maxAttempts" INTEGER NOT NULL DEFAULT 3, "retryAt" TIMESTAMP(3),
 "resultArtifactId" UUID, "resultStorageKey" VARCHAR(1024), "resultEtag" VARCHAR(160), "resultSha256" CHAR(64), "resultByteLength" BIGINT,
 "errorCode" VARCHAR(100), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3),
 CONSTRAINT "OutboundProbe_authority_check" CHECK (
  "kind" = 'rss_feed' AND "requestFingerprint" ~ '^[a-f0-9]{64}$' AND "inputHash" ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof("input")='object' AND octet_length("input"::text)<=65536
  AND "generation">0 AND "deploymentEpoch">0 AND "operationDeadlineAt">"createdAt"
  AND "status" IN ('queued','processing','completed','failed','cancelled')
  AND "chargedAttempts">=0 AND "maxAttempts" BETWEEN 1 AND 10 AND "chargedAttempts"<="maxAttempts"
  AND (("executorOwner" IS NULL)=("leaseExpiresAt" IS NULL)) AND ("executorOwner" IS NULL OR "attemptToken" IS NOT NULL)
  AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<="operationDeadlineAt") AND ("status"<>'processing' OR "executorOwner" IS NOT NULL)
  AND ("status" NOT IN ('completed','failed','cancelled') OR "completedAt" IS NOT NULL)
  AND num_nonnulls("resultArtifactId","resultStorageKey","resultEtag","resultSha256","resultByteLength") IN (0,5)
  AND ("resultByteLength" IS NULL OR ("resultByteLength" BETWEEN 1 AND 4194304 AND "resultSha256" ~ '^[a-f0-9]{64}$'))
  AND ("status"<>'completed' OR "resultArtifactId" IS NOT NULL)
 )
);
CREATE UNIQUE INDEX "OutboundProbe_workspaceId_createdByUserId_requestFingerprint_key" ON "OutboundProbe"("workspaceId","createdByUserId","requestFingerprint");
CREATE INDEX "OutboundProbe_status_retryAt_createdAt_idx" ON "OutboundProbe"("status","retryAt","createdAt");
CREATE FUNCTION outbound_probe_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER "OutboundProbe_input_immutable" BEFORE UPDATE ON "OutboundProbe" FOR EACH ROW EXECUTE FUNCTION outbound_probe_input_immutable();


ALTER TABLE "GeneratedMediaJob" ADD COLUMN "validationJobId" UUID, ADD COLUMN "validationInput" JSONB;
CREATE UNIQUE INDEX "GeneratedMediaJob_validationJobId_key" ON "GeneratedMediaJob"("validationJobId");
ALTER TABLE "GeneratedMediaJob" ADD CONSTRAINT "GeneratedMediaJob_validation_wait_check" CHECK (
 ("validationInput" IS NULL OR (jsonb_typeof("validationInput")='object' AND octet_length("validationInput"::text)<=65536))
 AND ("validationJobId" IS NULL OR ("validationInput" IS NOT NULL AND "status" IN ('waiting','completed','failed','cancelled') AND "claimId" IS NULL AND "claimExpiresAt" IS NULL))
);
CREATE FUNCTION generated_media_validation_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."validationInput" IS NOT NULL AND NOT (OLD."validationJobId" IS NULL AND OLD."outcomeUnknown" AND NOT NEW."outcomeUnknown" AND NEW."status"='queued' AND NEW."validationInput" IS NULL AND NEW."validationJobId" IS NULL AND NEW."providerRef" IS NULL AND NEW."providerUsageImages" IS NULL AND NEW."providerResultContentType" IS NULL AND NEW."claimId" IS NULL AND NEW."claimExpiresAt" IS NULL) AND
  (NEW."validationInput",NEW."workspaceId",NEW."projectId",NEW."createdByUserId",NEW."attempt",NEW."providerRef",NEW."providerResultContentType",NEW."providerUsageImages",NEW."usageReservationId",NEW."requestFingerprint") IS DISTINCT FROM
  (OLD."validationInput",OLD."workspaceId",OLD."projectId",OLD."createdByUserId",OLD."attempt",OLD."providerRef",OLD."providerResultContentType",OLD."providerUsageImages",OLD."usageReservationId",OLD."requestFingerprint") THEN
  RAISE EXCEPTION 'generated validation lineage is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."validationJobId" IS NOT NULL AND NEW."validationJobId" IS DISTINCT FROM OLD."validationJobId" THEN
  RAISE EXCEPTION 'generated validation child is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."validationJobId" IS NOT NULL AND OLD."status" IN ('completed','failed','cancelled') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
  RAISE EXCEPTION 'generated validation terminal state is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "GeneratedMediaJob_validation_binding_immutable" BEFORE UPDATE ON "GeneratedMediaJob"
 FOR EACH ROW EXECUTE FUNCTION generated_media_validation_binding_immutable();

-- Pending progress catchup reads two indexed endpoints, never Project history.
CREATE INDEX "WorkflowEvent_unpublished_progress_project_seq_idx" ON "WorkflowEvent"("projectId", "seq")
 WHERE "progressRequired" = true AND "progressPublishedAt" IS NULL;
