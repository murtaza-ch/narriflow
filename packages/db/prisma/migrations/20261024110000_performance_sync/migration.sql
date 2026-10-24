-- Performance sync: replaces the never-written SocialPostMetric (and the
-- always-null ProviderReceipt.metrics) with Tracked Videos and scheduled
-- Performance Captures that outlive the Project.

-- CreateEnum
CREATE TYPE "PerformanceCaptureState" AS ENUM ('scheduled', 'captured', 'skipped');

-- DropForeignKey
ALTER TABLE "SocialPostMetric" DROP CONSTRAINT "SocialPostMetric_projectId_fkey";

-- DropForeignKey
ALTER TABLE "SocialPostMetric" DROP CONSTRAINT "SocialPostMetric_postId_fkey";

-- AlterTable
ALTER TABLE "ProviderReceipt" DROP COLUMN "metrics";

-- DropTable
DROP TABLE "SocialPostMetric";

-- CreateTable
CREATE TABLE "TrackedVideo" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "socialAccountId" UUID,
    "socialPostId" UUID,
    "platform" "SocialPlatform" NOT NULL,
    "platformPostId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "clipFacts" JSONB,
    "clipFactsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackedVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceCapture" (
    "id" UUID NOT NULL,
    "trackedVideoId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "state" "PerformanceCaptureState" NOT NULL DEFAULT 'scheduled',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "capturedAt" TIMESTAMP(3),
    "apiVersion" TEXT,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "watchTimeSeconds" INTEGER,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceCapture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PublishedSocialVideo_publishedAt_idx" ON "PublishedSocialVideo"("publishedAt");

-- CreateIndex
CREATE INDEX "TrackedVideo_workspaceId_publishedAt_idx" ON "TrackedVideo"("workspaceId", "publishedAt");

-- CreateIndex
CREATE INDEX "TrackedVideo_socialPostId_idx" ON "TrackedVideo"("socialPostId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedVideo_workspaceId_platform_platformPostId_key" ON "TrackedVideo"("workspaceId", "platform", "platformPostId");

-- CreateIndex
CREATE INDEX "PerformanceCapture_state_dueAt_idx" ON "PerformanceCapture"("state", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceCapture_trackedVideoId_slot_key" ON "PerformanceCapture"("trackedVideoId", "slot");

-- AddForeignKey
ALTER TABLE "TrackedVideo" ADD CONSTRAINT "TrackedVideo_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedVideo" ADD CONSTRAINT "TrackedVideo_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedVideo" ADD CONSTRAINT "TrackedVideo_socialPostId_fkey" FOREIGN KEY ("socialPostId") REFERENCES "SocialPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceCapture" ADD CONSTRAINT "PerformanceCapture_trackedVideoId_fkey" FOREIGN KEY ("trackedVideoId") REFERENCES "TrackedVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
