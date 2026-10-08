-- Completion Callbacks: per-request signed notifications for terminal
-- Operation Status, and each Workspace's signing secrets.

-- CreateTable
CREATE TABLE "CompletionCallback" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "operationKind" TEXT NOT NULL,
    "operationId" UUID NOT NULL,
    "receiptId" UUID,
    "uploadSessionId" UUID,
    "encryptedUrl" TEXT NOT NULL,
    "urlHost" TEXT NOT NULL,
    "urlFingerprint" TEXT NOT NULL,
    "eventId" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'waiting',
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "nextObservationAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "payload" JSONB,
    "lastResponseStatus" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompletionCallback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallbackSigningSecret" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiresAt" TIMESTAMP(3),

    CONSTRAINT "CallbackSigningSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompletionCallback_receiptId_key" ON "CompletionCallback"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "CompletionCallback_uploadSessionId_key" ON "CompletionCallback"("uploadSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CompletionCallback_eventId_key" ON "CompletionCallback"("eventId");

-- CreateIndex
CREATE INDEX "CompletionCallback_state_nextObservationAt_idx" ON "CompletionCallback"("state", "nextObservationAt");

-- CreateIndex
CREATE INDEX "CompletionCallback_state_nextAttemptAt_idx" ON "CompletionCallback"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CompletionCallback_workspaceId_operationKind_operationId_idx" ON "CompletionCallback"("workspaceId", "operationKind", "operationId");

-- CreateIndex
CREATE INDEX "CallbackSigningSecret_workspaceId_retiresAt_idx" ON "CallbackSigningSecret"("workspaceId", "retiresAt");

-- AddForeignKey
ALTER TABLE "CompletionCallback" ADD CONSTRAINT "CompletionCallback_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallbackSigningSecret" ADD CONSTRAINT "CallbackSigningSecret_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Every callback belongs to exactly one acceptance identity.
ALTER TABLE "CompletionCallback" ADD CONSTRAINT "CompletionCallback_one_acceptance" CHECK (("receiptId" IS NULL) <> ("uploadSessionId" IS NULL));
ALTER TABLE "CompletionCallback" ADD CONSTRAINT "CompletionCallback_state_check" CHECK ("state" IN ('waiting', 'pending', 'delivered', 'failed', 'cancelled'));
