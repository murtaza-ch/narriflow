-- Pre-production direct cutover: old local rounds cannot support durable resend
-- because they do not retain encrypted delivery capability material.
DELETE FROM "ReviewRound";

ALTER TABLE "ReviewRound"
  ADD COLUMN "deliveryTokenEncrypted" TEXT NOT NULL,
  ADD COLUMN "recipientEmails" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE "ReviewNotificationLedger" (
  "id" UUID NOT NULL,
  "reviewRoundId" UUID NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "leaseExpiresAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "providerMessageId" TEXT,
  "failureCode" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewNotificationLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewNotificationLedger_reviewRoundId_recipientEmail_kind_scopeKey_key"
  ON "ReviewNotificationLedger"("reviewRoundId", "recipientEmail", "kind", "scopeKey");
CREATE INDEX "ReviewNotificationLedger_status_nextAttemptAt_leaseExpiresAt_idx"
  ON "ReviewNotificationLedger"("status", "nextAttemptAt", "leaseExpiresAt");
CREATE INDEX "ReviewNotificationLedger_reviewRoundId_createdAt_idx"
  ON "ReviewNotificationLedger"("reviewRoundId", "createdAt");
ALTER TABLE "ReviewNotificationLedger"
  ADD CONSTRAINT "ReviewNotificationLedger_reviewRoundId_fkey"
  FOREIGN KEY ("reviewRoundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE;
