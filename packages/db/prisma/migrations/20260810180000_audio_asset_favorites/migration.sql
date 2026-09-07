-- Per-user Saved state for the studio Music/SFX library.
CREATE TABLE "AudioAssetFavorite" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioAssetFavorite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AudioAssetFavorite_userId_assetId_key"
ON "AudioAssetFavorite"("userId", "assetId");

CREATE INDEX "AudioAssetFavorite_userId_createdAt_idx"
ON "AudioAssetFavorite"("userId", "createdAt");

CREATE INDEX "AudioAssetFavorite_assetId_idx"
ON "AudioAssetFavorite"("assetId");

ALTER TABLE "AudioAssetFavorite"
ADD CONSTRAINT "AudioAssetFavorite_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AudioAssetFavorite"
ADD CONSTRAINT "AudioAssetFavorite_assetId_fkey"
FOREIGN KEY ("assetId") REFERENCES "AudioAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
