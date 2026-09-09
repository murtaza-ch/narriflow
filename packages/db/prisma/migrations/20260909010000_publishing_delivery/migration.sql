CREATE TYPE "SocialDeliveryMode" AS ENUM ('direct', 'tiktok_inbox');
ALTER TYPE "SocialPostStatus" ADD VALUE 'inbox_delivered';
ALTER TABLE "SocialPost" ADD COLUMN "deliveryMode" "SocialDeliveryMode" NOT NULL DEFAULT 'direct';
ALTER TABLE "FrozenPublicationState" ADD COLUMN "deliveryMode" "SocialDeliveryMode" NOT NULL DEFAULT 'direct';
ALTER TABLE "ProviderReceipt" ADD COLUMN "deliveryMode" "SocialDeliveryMode" NOT NULL DEFAULT 'direct', ADD COLUMN "inboxDeliveredAt" TIMESTAMP(3);
ALTER TABLE "AssistedCopyVariant" DROP COLUMN "confirmationFingerprint", DROP COLUMN "confirmedByUserId", DROP COLUMN "confirmedAt";
CREATE TABLE "PublishedSocialVideo" (
 "id" UUID NOT NULL, "socialPostId" UUID NOT NULL, "platformPostId" TEXT NOT NULL,
 "externalUrl" TEXT, "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PublishedSocialVideo_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "PublishedSocialVideo_socialPostId_fkey" FOREIGN KEY ("socialPostId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PublishedSocialVideo_socialPostId_platformPostId_key" ON "PublishedSocialVideo"("socialPostId", "platformPostId");
