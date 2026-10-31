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
  AND "subjectKind" IN ('ingest_job','workflow_run','render_group','clip_preparation','upload_session','social_publication','completion_callback','webhook_subscription','workspace_billing','autopilot_rule','generation_finishing','dubbing','export_bundle','generated_media','thumbnail_frame','library_index','notification','media_cleanup','workflow_event','workspace_event','standing_grant','pending_workspace','retention','maintenance')
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
  "audience" IN ('modal-bridge','executor-control','dev-device')
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
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_execution_revision_check" CHECK ("deploymentEpoch" > 0 AND "generation" > 0);
ALTER TABLE "RenderGroup" ADD CONSTRAINT "RenderGroup_execution_revision_check" CHECK ("deploymentEpoch" > 0 AND "generation" > 0);
ALTER TABLE "IngestJob" ADD CONSTRAINT "IngestJob_execution_revision_check" CHECK ("deploymentEpoch" > 0 AND "generation" > 0 AND "sourceRevision" > 0);
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_schedule_revision_check" CHECK ("scheduleRevision" > 0);

-- Dev-only passcodes are reset without making protected rounds accessible.
-- Revoke first in the same statement; review audits and recipient history remain.
UPDATE "ReviewRound" SET "revokedAt" = COALESCE("revokedAt", now()), "passcodeHash" = NULL
  WHERE "passcodeHash" IS NOT NULL;
