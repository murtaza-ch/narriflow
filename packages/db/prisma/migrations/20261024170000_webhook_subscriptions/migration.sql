-- Webhook Subscriptions: signed, ordered, at-least-once push delivery of a
-- Workspace's events to HTTPS endpoints.

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdByUserId" UUID,
    "encryptedUrl" TEXT NOT NULL,
    "urlHost" TEXT NOT NULL,
    "urlFingerprint" TEXT NOT NULL,
    "types" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastDeliveredSeq" BIGINT NOT NULL,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastResponseStatus" INTEGER,
    "lastDeliveredAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "disabledAt" TIMESTAMP(3),
    "disabledNotifiedAt" TIMESTAMP(3),
    "skipExpiredOnResume" BOOLEAN NOT NULL DEFAULT false,
    "lastTestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookSubscription_workspaceId_urlFingerprint_key" ON "WebhookSubscription"("workspaceId", "urlFingerprint");

-- CreateIndex
CREATE INDEX "WebhookSubscription_status_nextAttemptAt_idx" ON "WebhookSubscription"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookSubscription_createdByUserId_idx" ON "WebhookSubscription"("createdByUserId");

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A subscription is disabled exactly when it says why.
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_status_check" CHECK ("status" IN ('active', 'disabled'));
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_disabled_reason" CHECK (("status" = 'disabled') = ("disabledReason" IS NOT NULL));
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_types_not_empty" CHECK (cardinality("types") > 0);
