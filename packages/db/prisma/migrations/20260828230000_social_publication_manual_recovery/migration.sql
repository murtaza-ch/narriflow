CREATE TYPE "PublicationManualDecisionKind" AS ENUM (
  'recheck_requested',
  'confirmed_published',
  'republish_requested'
);

CREATE TYPE "PublicationEvidenceKind" AS ENUM (
  'provider_reference',
  'platform_url',
  'manual_unvalidated'
);

CREATE TABLE "PublicationManualDecision" (
  "id" UUID NOT NULL,
  "socialPostId" UUID NOT NULL,
  "attemptId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "kind" "PublicationManualDecisionKind" NOT NULL,
  "reason" TEXT NOT NULL,
  "evidenceKind" "PublicationEvidenceKind",
  "providerReference" TEXT,
  "externalUrl" TEXT,
  "ownershipValidated" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicationManualDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublicationManualDecision_reason_length" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "PublicationManualDecision_reference_length" CHECK ("providerReference" IS NULL OR char_length("providerReference") <= 500),
  CONSTRAINT "PublicationManualDecision_external_url_length" CHECK ("externalUrl" IS NULL OR char_length("externalUrl") <= 2048),
  CONSTRAINT "PublicationManualDecision_socialPostId_fkey" FOREIGN KEY ("socialPostId") REFERENCES "SocialPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PublicationManualDecision_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "SocialPublicationAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PublicationManualDecision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PublicationManualDecision_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "PublicationManualDecision_socialPostId_createdAt_idx"
  ON "PublicationManualDecision"("socialPostId", "createdAt");
CREATE INDEX "PublicationManualDecision_attemptId_createdAt_idx"
  ON "PublicationManualDecision"("attemptId", "createdAt");
CREATE INDEX "PublicationManualDecision_workspaceId_createdAt_idx"
  ON "PublicationManualDecision"("workspaceId", "createdAt");
