ALTER TABLE "ContentPack"
  ADD COLUMN "clipGenerationMode" TEXT NOT NULL DEFAULT 'best',
  ADD COLUMN "minDurationSec" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "preferredMinDurationSec" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "preferredMaxDurationSec" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "maxDurationSec" INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN "platformTargets" TEXT[] NOT NULL DEFAULT ARRAY['tiktok', 'youtube_shorts', 'instagram_reels']::TEXT[],
  ADD COLUMN "autoRenderClips" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Clip"
  ADD COLUMN "title" TEXT,
  ADD COLUMN "payoffText" TEXT,
  ADD COLUMN "platformFit" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "storyCompletenessScore" INTEGER NOT NULL DEFAULT 50;
