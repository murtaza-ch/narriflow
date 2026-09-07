-- Platform-side metrics reported back by social publishing integrations.

CREATE TABLE "SocialPostMetric" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "saves" INTEGER NOT NULL DEFAULT 0,
    "watchTimeSeconds" INTEGER,
    "metadata" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialPostMetric_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SocialPostMetric_projectId_capturedAt_idx"
ON "SocialPostMetric"("projectId", "capturedAt");

CREATE INDEX "SocialPostMetric_postId_capturedAt_idx"
ON "SocialPostMetric"("postId", "capturedAt");

CREATE INDEX "SocialPostMetric_platform_capturedAt_idx"
ON "SocialPostMetric"("platform", "capturedAt");

ALTER TABLE "SocialPostMetric"
ADD CONSTRAINT "SocialPostMetric_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialPostMetric"
ADD CONSTRAINT "SocialPostMetric_postId_fkey"
FOREIGN KEY ("postId") REFERENCES "SocialPost"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
