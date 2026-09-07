ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'brand_profile_created';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'brand_profile_applied';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'visual_asset_upload_succeeded';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'visual_asset_upload_failed';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'brand_font_upload_succeeded';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'brand_font_upload_failed';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'scene_template_used';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'brand_premium_mutation_blocked';

CREATE TABLE "ProgramAnalyticsEvent" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "projectId" UUID,
  "type" "AnalyticsEventType" NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProgramAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProgramAnalyticsEvent_workspaceId_createdAt_idx"
  ON "ProgramAnalyticsEvent"("workspaceId", "createdAt");
CREATE INDEX "ProgramAnalyticsEvent_projectId_createdAt_idx"
  ON "ProgramAnalyticsEvent"("projectId", "createdAt");
CREATE INDEX "ProgramAnalyticsEvent_type_createdAt_idx"
  ON "ProgramAnalyticsEvent"("type", "createdAt");
