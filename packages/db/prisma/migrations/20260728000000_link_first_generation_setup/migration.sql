-- Link-first generation setup (docs/plans/link-to-clips-uiux.md Phase 0)

-- ContentPack: draft state + persisted preset + default render ratio.
-- Existing rows backfill as committed (draft = false via the default).
ALTER TABLE "ContentPack" ADD COLUMN "draft" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ContentPack" ADD COLUMN "clipLengthPreset" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "ContentPack" ADD COLUMN "defaultAspectRatio" TEXT NOT NULL DEFAULT '9:16';

-- At most one draft per project (Prisma cannot express partial uniques).
CREATE UNIQUE INDEX "ContentPack_one_draft_per_project"
  ON "ContentPack" ("projectId")
  WHERE "draft";

-- WorkflowRun binds to the immutable pack it was claimed with.
ALTER TABLE "WorkflowRun" ADD COLUMN "contentPackId" UUID;
ALTER TABLE "WorkflowRun"
  ADD CONSTRAINT "WorkflowRun_contentPackId_fkey"
  FOREIGN KEY ("contentPackId") REFERENCES "ContentPack" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Project: durable Step-1 commit token + completion-notification preference.
ALTER TABLE "Project" ADD COLUMN "commitToken" UUID;
ALTER TABLE "Project" ADD COLUMN "notifyOnComplete" BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX "Project_commitToken_key" ON "Project" ("commitToken");

-- Send-once notification ledger (Phase 2b).
CREATE TABLE "NotificationLedger" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "outcome" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "leaseExpiresAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "providerMessageId" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NotificationLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationLedger_projectId_sourceId_outcome_key"
  ON "NotificationLedger" ("projectId", "sourceId", "outcome");
CREATE INDEX "NotificationLedger_status_leaseExpiresAt_idx"
  ON "NotificationLedger" ("status", "leaseExpiresAt");
