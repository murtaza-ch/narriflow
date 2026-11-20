-- Curated music/SFX library catalog: licence, provenance and ordering.
--
-- Additive: existing rows (user uploads and any curated rows) keep NULL
-- licence fields and the default sortOrder.
CREATE TYPE "AudioAssetLicense" AS ENUM ('cc0', 'cc_by_4');

ALTER TABLE "AudioAsset"
ADD COLUMN "license" "AudioAssetLicense",
ADD COLUMN "artist" TEXT,
ADD COLUMN "attribution" TEXT,
ADD COLUMN "sourceUrl" TEXT,
ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 1000;

CREATE INDEX "AudioAsset_kind_sortOrder_idx" ON "AudioAsset"("kind", "sortOrder");
