-- Narriflow is pre-production. In-flight rows from the status-only publisher
-- cannot be recovered honestly because they have no frozen export or provider
-- evidence, so the cutover removes them instead of adding a legacy protocol.
DELETE FROM "SocialPost"
WHERE "status" IN ('draft', 'scheduled', 'publishing');

ALTER TYPE "SocialPostStatus" ADD VALUE 'preparing_video';
ALTER TYPE "SocialPostStatus" ADD VALUE 'processing';
ALTER TYPE "SocialPostStatus" ADD VALUE 'reconciling';
ALTER TYPE "SocialPostStatus" ADD VALUE 'needs_attention';

CREATE TYPE "PublicationAttemptPhase" AS ENUM (
  'claimed',
  'preparing',
  'uploading',
  'submission_started',
  'processing',
  'reconciling',
  'retry_scheduled',
  'succeeded',
  'failed',
  'needs_attention'
);

CREATE TYPE "PublicationOutcome" AS ENUM (
  'accepted',
  'pending',
  'failed',
  'unknown'
);

CREATE TYPE "PublicationFailureDisposition" AS ENUM (
  'safe_retry',
  'permanent',
  'attention'
);

ALTER TABLE "SocialPost"
  ADD COLUMN "clientIdempotencyKey" TEXT,
  ADD COLUMN "immutableRequestHash" TEXT,
  ADD COLUMN "errorDisposition" "PublicationFailureDisposition",
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "SocialPost_workspaceId_clientIdempotencyKey_key"
  ON "SocialPost"("workspaceId", "clientIdempotencyKey");

CREATE TABLE "FrozenPublicationState" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "socialPostId" UUID NOT NULL,
  "clipExportId" UUID NOT NULL,
  "clipExportVariantId" UUID NOT NULL,
  "socialAccountId" UUID,
  "platform" "SocialPlatform" NOT NULL,
  "editorRevision" INTEGER NOT NULL,
  "exportFingerprint" TEXT NOT NULL,
  "storageKey" TEXT,
  "sizeBytes" BIGINT,
  "aspectRatio" "ClipAspectRatio" NOT NULL,
  "caption" TEXT NOT NULL,
  "providerSettings" JSONB NOT NULL,
  "capabilityVersion" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "mediaReadyAt" TIMESTAMP(3),
  CONSTRAINT "FrozenPublicationState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SocialPublicationAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "socialPostId" UUID NOT NULL,
  "frozenStateId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "priorAttemptId" UUID,
  "idempotencyKey" TEXT NOT NULL,
  "phase" "PublicationAttemptPhase" NOT NULL,
  "outcome" "PublicationOutcome",
  "failureCode" TEXT,
  "failureDisposition" "PublicationFailureDisposition",
  "nextActionAt" TIMESTAMP(3) NOT NULL,
  "providerCallCount" INTEGER NOT NULL DEFAULT 0,
  "processingDeadline" TIMESTAMP(3) NOT NULL,
  "operationKind" TEXT,
  "checkpointEncrypted" TEXT,
  "currentClaimId" UUID,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "terminalAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialPublicationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PublicationClaim" (
  "id" UUID NOT NULL,
  "attemptId" UUID NOT NULL,
  "claimantId" TEXT NOT NULL,
  "accountSlotKey" UUID,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "heartbeatAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicationClaim_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderReceipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "attemptId" UUID NOT NULL,
  "platform" "SocialPlatform" NOT NULL,
  "receiptId" TEXT NOT NULL,
  "platformPostId" TEXT,
  "externalUrl" TEXT,
  "metrics" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "enrichedAt" TIMESTAMP(3),
  CONSTRAINT "ProviderReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PublicationAnalyticsIntent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "attemptId" UUID NOT NULL,
  "socialPostId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicationAnalyticsIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FrozenPublicationState_socialPostId_key"
  ON "FrozenPublicationState"("socialPostId");
CREATE INDEX "FrozenPublicationState_clipExportId_idx"
  ON "FrozenPublicationState"("clipExportId");
CREATE INDEX "FrozenPublicationState_clipExportVariantId_idx"
  ON "FrozenPublicationState"("clipExportVariantId");
CREATE INDEX "FrozenPublicationState_socialAccountId_idx"
  ON "FrozenPublicationState"("socialAccountId");

CREATE UNIQUE INDEX "SocialPublicationAttempt_idempotencyKey_key"
  ON "SocialPublicationAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "SocialPublicationAttempt_currentClaimId_key"
  ON "SocialPublicationAttempt"("currentClaimId");
CREATE UNIQUE INDEX "SocialPublicationAttempt_socialPostId_attemptNumber_key"
  ON "SocialPublicationAttempt"("socialPostId", "attemptNumber");
CREATE INDEX "SocialPublicationAttempt_phase_nextActionAt_id_idx"
  ON "SocialPublicationAttempt"("phase", "nextActionAt", "id");
CREATE INDEX "SocialPublicationAttempt_socialPostId_createdAt_idx"
  ON "SocialPublicationAttempt"("socialPostId", "createdAt");

CREATE UNIQUE INDEX "PublicationClaim_accountSlotKey_key"
  ON "PublicationClaim"("accountSlotKey");
CREATE INDEX "PublicationClaim_attemptId_createdAt_idx"
  ON "PublicationClaim"("attemptId", "createdAt");
CREATE INDEX "PublicationClaim_leaseExpiresAt_releasedAt_idx"
  ON "PublicationClaim"("leaseExpiresAt", "releasedAt");

CREATE UNIQUE INDEX "ProviderReceipt_attemptId_key"
  ON "ProviderReceipt"("attemptId");
CREATE INDEX "ProviderReceipt_platform_receiptId_idx"
  ON "ProviderReceipt"("platform", "receiptId");
CREATE INDEX "ProviderReceipt_platform_platformPostId_idx"
  ON "ProviderReceipt"("platform", "platformPostId");

CREATE UNIQUE INDEX "PublicationAnalyticsIntent_attemptId_key"
  ON "PublicationAnalyticsIntent"("attemptId");
CREATE INDEX "PublicationAnalyticsIntent_deliveredAt_createdAt_idx"
  ON "PublicationAnalyticsIntent"("deliveredAt", "createdAt");
CREATE INDEX "PublicationAnalyticsIntent_projectId_createdAt_idx"
  ON "PublicationAnalyticsIntent"("projectId", "createdAt");

ALTER TABLE "FrozenPublicationState"
  ADD CONSTRAINT "FrozenPublicationState_socialPostId_fkey"
  FOREIGN KEY ("socialPostId") REFERENCES "SocialPost"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FrozenPublicationState"
  ADD CONSTRAINT "FrozenPublicationState_clipExportId_fkey"
  FOREIGN KEY ("clipExportId") REFERENCES "ClipExport"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FrozenPublicationState"
  ADD CONSTRAINT "FrozenPublicationState_clipExportVariantId_fkey"
  FOREIGN KEY ("clipExportVariantId") REFERENCES "ClipExportVariant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FrozenPublicationState"
  ADD CONSTRAINT "FrozenPublicationState_socialAccountId_fkey"
  FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SocialPublicationAttempt"
  ADD CONSTRAINT "SocialPublicationAttempt_socialPostId_fkey"
  FOREIGN KEY ("socialPostId") REFERENCES "SocialPost"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPublicationAttempt"
  ADD CONSTRAINT "SocialPublicationAttempt_frozenStateId_fkey"
  FOREIGN KEY ("frozenStateId") REFERENCES "FrozenPublicationState"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SocialPublicationAttempt"
  ADD CONSTRAINT "SocialPublicationAttempt_priorAttemptId_fkey"
  FOREIGN KEY ("priorAttemptId") REFERENCES "SocialPublicationAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PublicationClaim"
  ADD CONSTRAINT "PublicationClaim_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "SocialPublicationAttempt"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProviderReceipt"
  ADD CONSTRAINT "ProviderReceipt_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "SocialPublicationAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PublicationAnalyticsIntent"
  ADD CONSTRAINT "PublicationAnalyticsIntent_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "SocialPublicationAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
