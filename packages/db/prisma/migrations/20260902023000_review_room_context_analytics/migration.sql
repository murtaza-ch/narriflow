ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'review_first_comment';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'review_item_approved';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'review_resubmitted';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'review_expired';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'review_revoked';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'review_approval_overridden';

ALTER TABLE "ReviewRound"
  ADD COLUMN "firstOpenedAt" TIMESTAMP(3),
  ADD COLUMN "firstCommentAt" TIMESTAMP(3),
  ADD COLUMN "firstChangeRequestedAt" TIMESTAMP(3),
  ADD COLUMN "expiryRecordedAt" TIMESTAMP(3);

CREATE TABLE "ReviewRoundContext" (
  "id" UUID NOT NULL,
  "reviewRoundId" UUID NOT NULL,
  "sourceCommentId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewRoundContext_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewRoundContext_reviewRoundId_sourceCommentId_key"
  ON "ReviewRoundContext"("reviewRoundId", "sourceCommentId");
CREATE INDEX "ReviewRoundContext_sourceCommentId_idx"
  ON "ReviewRoundContext"("sourceCommentId");

ALTER TABLE "ReviewRoundContext"
  ADD CONSTRAINT "ReviewRoundContext_reviewRoundId_fkey"
  FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE;
ALTER TABLE "ReviewRoundContext"
  ADD CONSTRAINT "ReviewRoundContext_sourceCommentId_fkey"
  FOREIGN KEY ("sourceCommentId") REFERENCES "ReviewComment"("id") ON DELETE RESTRICT;
