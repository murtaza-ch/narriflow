-- Standing grants: authority an Owner or Admin gives one Autopilot rule's output
-- to go out without a click, with caps, an expiry, a pause, and an audit trail.

-- CreateEnum
CREATE TYPE "StandingGrantKind" AS ENUM ('publish', 'review_send');

-- CreateEnum
CREATE TYPE "StandingGrantStatus" AS ENUM ('active', 'paused', 'expired', 'revoked');

-- AlterTable
ALTER TABLE "ContentPack" ADD COLUMN     "autopilotRuleId" UUID;

-- AlterTable
ALTER TABLE "ReviewRound" ADD COLUMN     "finishingId" UUID,
ADD COLUMN     "standingGrantId" UUID,
ADD COLUMN     "standingGrantRevision" INTEGER;

-- AlterTable
ALTER TABLE "SocialPost" ADD COLUMN     "standingGrantId" UUID,
ADD COLUMN     "standingGrantRevision" INTEGER;

-- AlterTable
ALTER TABLE "GenerationFinishing" ADD COLUMN     "autopilotRuleId" UUID;

-- CreateTable
CREATE TABLE "StandingGrant" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" "StandingGrantKind" NOT NULL,
    "autopilotRuleId" UUID,
    "socialAccountId" UUID,
    "reviewerEmails" JSONB,
    "dailyCap" INTEGER NOT NULL,
    "weeklyCap" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "StandingGrantStatus" NOT NULL DEFAULT 'active',
    "pausedReason" TEXT,
    "pauseNoticePending" BOOLEAN NOT NULL DEFAULT false,
    "pauseNoticeLeaseUntil" TIMESTAMP(3),
    "ruleFingerprint" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "grantedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StandingGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StandingGrantEvent" (
    "id" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "actorUserId" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandingGrantEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewerOptOut" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewerOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StandingGrant_workspaceId_status_idx" ON "StandingGrant"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "StandingGrant_autopilotRuleId_status_idx" ON "StandingGrant"("autopilotRuleId", "status");

-- CreateIndex
CREATE INDEX "StandingGrant_status_expiresAt_idx" ON "StandingGrant"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "StandingGrant_pauseNoticePending_idx" ON "StandingGrant"("pauseNoticePending");

-- CreateIndex
CREATE INDEX "StandingGrantEvent_grantId_createdAt_idx" ON "StandingGrantEvent"("grantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewerOptOut_workspaceId_email_key" ON "ReviewerOptOut"("workspaceId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRound_finishingId_key" ON "ReviewRound"("finishingId");

-- CreateIndex
CREATE INDEX "ReviewRound_standingGrantId_createdAt_idx" ON "ReviewRound"("standingGrantId", "createdAt");

-- CreateIndex
CREATE INDEX "SocialPost_standingGrantId_idx" ON "SocialPost"("standingGrantId");

-- AddForeignKey
ALTER TABLE "ReviewRound" ADD CONSTRAINT "ReviewRound_standingGrantId_fkey" FOREIGN KEY ("standingGrantId") REFERENCES "StandingGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRound" ADD CONSTRAINT "ReviewRound_finishingId_fkey" FOREIGN KEY ("finishingId") REFERENCES "GenerationFinishing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_standingGrantId_fkey" FOREIGN KEY ("standingGrantId") REFERENCES "StandingGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandingGrant" ADD CONSTRAINT "StandingGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandingGrant" ADD CONSTRAINT "StandingGrant_autopilotRuleId_fkey" FOREIGN KEY ("autopilotRuleId") REFERENCES "AutopilotRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandingGrant" ADD CONSTRAINT "StandingGrant_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandingGrant" ADD CONSTRAINT "StandingGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandingGrantEvent" ADD CONSTRAINT "StandingGrantEvent_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "StandingGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerOptOut" ADD CONSTRAINT "ReviewerOptOut_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
