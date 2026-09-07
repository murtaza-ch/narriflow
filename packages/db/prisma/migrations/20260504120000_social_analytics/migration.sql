-- Social scheduling metadata and first-party project analytics.
CREATE TYPE "SocialPlatform" AS ENUM ('tiktok', 'youtube_shorts', 'instagram_reels', 'linkedin', 'x');
CREATE TYPE "SocialPostStatus" AS ENUM ('draft', 'scheduled', 'posted', 'failed', 'cancelled');
CREATE TYPE "AnalyticsEventType" AS ENUM ('render_completed', 'download_opened', 'social_scheduled', 'social_cancelled');

CREATE TABLE "SocialPost" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "clipId" UUID,
  "platform" "SocialPlatform" NOT NULL,
  "status" "SocialPostStatus" NOT NULL DEFAULT 'scheduled',
  "caption" TEXT NOT NULL,
  "aspectRatio" "ClipAspectRatio",
  "scheduledFor" TIMESTAMP(3),
  "postedAt" TIMESTAMP(3),
  "externalUrl" TEXT,
  "errorCode" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectAnalyticsEvent" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "clipId" UUID,
  "type" "AnalyticsEventType" NOT NULL,
  "platform" "SocialPlatform",
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SocialPost_projectId_scheduledFor_idx" ON "SocialPost"("projectId", "scheduledFor");
CREATE INDEX "SocialPost_status_scheduledFor_idx" ON "SocialPost"("status", "scheduledFor");
CREATE INDEX "SocialPost_clipId_idx" ON "SocialPost"("clipId");
CREATE INDEX "ProjectAnalyticsEvent_projectId_createdAt_idx" ON "ProjectAnalyticsEvent"("projectId", "createdAt");
CREATE INDEX "ProjectAnalyticsEvent_clipId_type_idx" ON "ProjectAnalyticsEvent"("clipId", "type");
CREATE INDEX "ProjectAnalyticsEvent_type_createdAt_idx" ON "ProjectAnalyticsEvent"("type", "createdAt");

ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectAnalyticsEvent" ADD CONSTRAINT "ProjectAnalyticsEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAnalyticsEvent" ADD CONSTRAINT "ProjectAnalyticsEvent_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
