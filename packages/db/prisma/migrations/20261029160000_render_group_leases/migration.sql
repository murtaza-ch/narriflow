-- CreateEnum
CREATE TYPE "RenderGroupStatus" AS ENUM ('queued', 'running', 'completed', 'partial', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "RenderGroupExecutionResult" AS ENUM ('completed', 'partial', 'failed', 'interrupted', 'released', 'superseded');

-- CreateEnum
CREATE TYPE "RenderGroupVariantResult" AS ENUM ('completed', 'retryable', 'permanent', 'superseded');

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN     "renderWorkSetGeneration" UUID;

-- CreateTable
CREATE TABLE "RenderGroup" (
    "id" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "workSetGeneration" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "exportIdentity" TEXT NOT NULL,
    "status" "RenderGroupStatus" NOT NULL DEFAULT 'queued',
    "attemptToken" UUID,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "chargedAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "failureDisposition" "ClipRenderFailureDisposition",
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderGroupMember" (
    "groupId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "workSetGeneration" UUID NOT NULL,
    "clipRenderId" UUID NOT NULL,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenderGroupMember_pkey" PRIMARY KEY ("groupId","clipRenderId")
);

-- CreateTable
CREATE TABLE "RenderGroupExecution" (
    "token" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "owner" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "charged" BOOLEAN NOT NULL DEFAULT false,
    "result" "RenderGroupExecutionResult",
    "errorCode" TEXT,
    "failureDisposition" "ClipRenderFailureDisposition",
    "sourceFingerprint" TEXT,
    "analysisFingerprint" TEXT,
    "toolchainFingerprint" TEXT,

    CONSTRAINT "RenderGroupExecution_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "RenderGroupVariantOutcome" (
    "token" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "clipRenderId" UUID NOT NULL,
    "result" "RenderGroupVariantResult" NOT NULL,
    "errorCode" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenderGroupVariantOutcome_pkey" PRIMARY KEY ("token","clipRenderId")
);

-- CreateIndex
CREATE UNIQUE INDEX "RenderGroup_attemptToken_key" ON "RenderGroup"("attemptToken");

-- CreateIndex
CREATE INDEX "RenderGroup_status_nextAttemptAt_createdAt_idx" ON "RenderGroup"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "RenderGroup_status_leaseExpiresAt_idx" ON "RenderGroup"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RenderGroup_identity_key" ON "RenderGroup"("workflowRunId", "workSetGeneration", "clipId", "exportIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "RenderGroup_id_workflowRunId_workSetGeneration_key" ON "RenderGroup"("id", "workflowRunId", "workSetGeneration");

-- CreateIndex
CREATE UNIQUE INDEX "RenderGroup_attemptToken_id_key" ON "RenderGroup"("attemptToken", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RenderGroupMember_membership_key" ON "RenderGroupMember"("workflowRunId", "workSetGeneration", "clipRenderId");

-- CreateIndex
CREATE INDEX "RenderGroupExecution_groupId_claimedAt_idx" ON "RenderGroupExecution"("groupId", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RenderGroupExecution_token_groupId_key" ON "RenderGroupExecution"("token", "groupId");

-- CreateIndex
CREATE INDEX "RenderGroupVariantOutcome_groupId_clipRenderId_idx" ON "RenderGroupVariantOutcome"("groupId", "clipRenderId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_id_renderWorkSetGeneration_key" ON "WorkflowRun"("id", "renderWorkSetGeneration");

-- AddForeignKey
ALTER TABLE "RenderGroup" ADD CONSTRAINT "RenderGroup_workflowRunId_workSetGeneration_fkey" FOREIGN KEY ("workflowRunId", "workSetGeneration") REFERENCES "WorkflowRun"("id", "renderWorkSetGeneration") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RenderGroup" ADD CONSTRAINT "RenderGroup_attemptToken_id_fkey" FOREIGN KEY ("attemptToken", "id") REFERENCES "RenderGroupExecution"("token", "groupId") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RenderGroupMember" ADD CONSTRAINT "RenderGroupMember_groupId_workflowRunId_workSetGeneration_fkey" FOREIGN KEY ("groupId", "workflowRunId", "workSetGeneration") REFERENCES "RenderGroup"("id", "workflowRunId", "workSetGeneration") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RenderGroupExecution" ADD CONSTRAINT "RenderGroupExecution_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "RenderGroup"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RenderGroupVariantOutcome" ADD CONSTRAINT "RenderGroupVariantOutcome_token_groupId_fkey" FOREIGN KEY ("token", "groupId") REFERENCES "RenderGroupExecution"("token", "groupId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RenderGroupVariantOutcome" ADD CONSTRAINT "RenderGroupVariantOutcome_groupId_clipRenderId_fkey" FOREIGN KEY ("groupId", "clipRenderId") REFERENCES "RenderGroupMember"("groupId", "clipRenderId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Protocol invariants Prisma cannot express. These constrain only new groups;
-- existing parent-only workers keep writing the old tables until 18-20 deploy.
ALTER TABLE "RenderGroup"
  ADD CONSTRAINT "RenderGroup_attempt_budget_check" CHECK ("chargedAttemptCount" BETWEEN 0 AND 3),
  ADD CONSTRAINT "RenderGroup_identity_check" CHECK (length("exportIdentity") > 0),
  ADD CONSTRAINT "RenderGroup_lease_check" CHECK (
    ("status" = 'running' AND "attemptToken" IS NOT NULL AND "leaseOwner" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL)
    OR ("status" <> 'running' AND "attemptToken" IS NULL AND "leaseOwner" IS NULL
      AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL)),
  ADD CONSTRAINT "RenderGroup_settlement_check" CHECK (
    ("status" IN ('queued', 'running') AND "settledAt" IS NULL)
    OR ("status" IN ('completed', 'partial', 'failed', 'superseded') AND "settledAt" IS NOT NULL)),
  ADD CONSTRAINT "RenderGroup_retry_check" CHECK ("nextAttemptAt" IS NULL OR "status" = 'queued');

ALTER TABLE "RenderGroupExecution"
  ADD CONSTRAINT "RenderGroupExecution_charge_check" CHECK (NOT "charged" OR "startedAt" IS NOT NULL),
  ADD CONSTRAINT "RenderGroupExecution_outcome_check" CHECK (("finishedAt" IS NULL) = ("result" IS NULL)),
  ADD CONSTRAINT "RenderGroupExecution_release_check" CHECK ("result" IS DISTINCT FROM 'released' OR NOT "charged");

-- The service owns claim/heartbeat/settlement. The DB also rejects accidental
-- identity rewrites, so old tokens and historical membership cannot migrate.
CREATE FUNCTION render_group_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'attemptToken', 'leaseOwner', 'leaseExpiresAt',
      'heartbeatAt', 'nextAttemptAt', 'chargedAttemptCount', 'errorCode',
      'failureDisposition', 'settledAt', 'updatedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'attemptToken', 'leaseOwner', 'leaseExpiresAt',
      'heartbeatAt', 'nextAttemptAt', 'chargedAttemptCount', 'errorCode',
      'failureDisposition', 'settledAt', 'updatedAt']) THEN
    RAISE EXCEPTION 'render group identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RenderGroup_identity_immutable" BEFORE UPDATE ON "RenderGroup"
FOR EACH ROW EXECUTE FUNCTION render_group_identity_immutable();

CREATE FUNCTION render_group_member_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'invalidatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'invalidatedAt')
     OR (OLD."invalidatedAt" IS NOT NULL AND NEW."invalidatedAt" IS DISTINCT FROM OLD."invalidatedAt") THEN
    RAISE EXCEPTION 'render group membership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RenderGroupMember_identity_immutable" BEFORE UPDATE ON "RenderGroupMember"
FOR EACH ROW EXECUTE FUNCTION render_group_member_immutable();

CREATE FUNCTION render_group_execution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."token", NEW."groupId", NEW."owner", NEW."claimedAt") IS DISTINCT FROM
     (OLD."token", OLD."groupId", OLD."owner", OLD."claimedAt")
     OR (OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt")
     OR (OLD."finishedAt" IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'render group execution identity or settled result is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RenderGroupExecution_identity_immutable" BEFORE UPDATE ON "RenderGroupExecution"
FOR EACH ROW EXECUTE FUNCTION render_group_execution_immutable();

CREATE FUNCTION render_group_variant_outcome_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'render group variant outcome is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RenderGroupVariantOutcome_immutable" BEFORE UPDATE ON "RenderGroupVariantOutcome"
FOR EACH ROW EXECUTE FUNCTION render_group_variant_outcome_immutable();
