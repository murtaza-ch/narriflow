-- Music/SFX library (docs/plans/vizard-parity.md "Music/SFX library").
--
-- One table for both curated and user-owned rows: `userId` NULL marks a
-- curated row seeded from packages/db/audio-manifest.json via
-- scripts/seed-audio-assets.ts, non-NULL marks a user's own upload.
-- `storageKey` is UNIQUE because it doubles as the R2 object identity — two
-- rows must never point at the same object. `deletedAt` is a soft-delete
-- flag that only applies to user uploads in practice (curated rows are
-- removed from the manifest and left in place, not soft-deleted).

CREATE TYPE "AudioAssetKind" AS ENUM ('music', 'sfx');

CREATE TABLE "AudioAsset" (
    "id" UUID NOT NULL,
    "kind" "AudioAssetKind" NOT NULL,
    "userId" UUID,
    "storageKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "moodTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "durationSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AudioAsset_storageKey_key" ON "AudioAsset"("storageKey");
CREATE INDEX "AudioAsset_kind_userId_idx" ON "AudioAsset"("kind", "userId");
CREATE INDEX "AudioAsset_userId_deletedAt_createdAt_idx" ON "AudioAsset"("userId", "deletedAt", "createdAt");

ALTER TABLE "AudioAsset"
ADD CONSTRAINT "AudioAsset_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
