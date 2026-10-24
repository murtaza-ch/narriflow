-- Performance Guidance: what tends to work for one Workspace's audience,
-- computed about nightly from recent Tracked Videos' frozen clip facts and
-- 7-day counts, normalised per platform.

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "usePerformanceGuidance" BOOLEAN;

-- AlterTable: the clip a video is of, so a clip posted to several platforms counts once.
ALTER TABLE "TrackedVideo" ADD COLUMN "clipId" UUID;

UPDATE "TrackedVideo" tv SET "clipId" = sp."clipId"
FROM "SocialPost" sp
WHERE sp."id" = tv."socialPostId" AND sp."clipId" IS NOT NULL;

-- CreateTable
CREATE TABLE "PerformanceGuidance" (
    "workspaceId" UUID NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL,
    "totalPosts" INTEGER NOT NULL,
    "platforms" JSONB NOT NULL,
    "groups" JSONB NOT NULL,

    CONSTRAINT "PerformanceGuidance_pkey" PRIMARY KEY ("workspaceId")
);

-- AddForeignKey
ALTER TABLE "PerformanceGuidance" ADD CONSTRAINT "PerformanceGuidance_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
