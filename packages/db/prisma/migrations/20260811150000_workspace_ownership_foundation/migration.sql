-- Phase 1 is deliberately additive for owned resources. The legacy userId
-- columns remain until dual-read/dual-write verification is complete.

CREATE TYPE "WorkspaceStatus" AS ENUM ('active', 'pending_payment', 'restricted');

ALTER TABLE "Team" RENAME TO "Workspace";
ALTER TABLE "TeamMember" RENAME TO "WorkspaceMember";
ALTER TABLE "TeamInvite" RENAME TO "WorkspaceInvite";
ALTER TABLE "WorkspaceMember" RENAME COLUMN "teamId" TO "workspaceId";
ALTER TABLE "WorkspaceInvite" RENAME COLUMN "teamId" TO "workspaceId";

-- PostgreSQL keeps constraint/index names when tables and columns are
-- renamed. Align those physical names with the Prisma models now so the next
-- migration does not report a false schema drift or create duplicate indexes.
ALTER TABLE "Workspace" RENAME CONSTRAINT "Team_pkey" TO "Workspace_pkey";
ALTER TABLE "Workspace" RENAME CONSTRAINT "Team_ownerUserId_fkey" TO "Workspace_ownerUserId_fkey";
ALTER INDEX "Team_ownerUserId_idx" RENAME TO "Workspace_ownerUserId_idx";
ALTER TABLE "WorkspaceMember" RENAME CONSTRAINT "TeamMember_pkey" TO "WorkspaceMember_pkey";
ALTER TABLE "WorkspaceMember" RENAME CONSTRAINT "TeamMember_teamId_fkey" TO "WorkspaceMember_workspaceId_fkey";
ALTER TABLE "WorkspaceMember" RENAME CONSTRAINT "TeamMember_userId_fkey" TO "WorkspaceMember_userId_fkey";
ALTER INDEX "TeamMember_teamId_userId_key" RENAME TO "WorkspaceMember_workspaceId_userId_key";
DROP INDEX "TeamMember_userId_idx";
ALTER TABLE "WorkspaceInvite" RENAME CONSTRAINT "TeamInvite_pkey" TO "WorkspaceInvite_pkey";
ALTER TABLE "WorkspaceInvite" RENAME CONSTRAINT "TeamInvite_teamId_fkey" TO "WorkspaceInvite_workspaceId_fkey";
ALTER INDEX "TeamInvite_tokenHash_key" RENAME TO "WorkspaceInvite_tokenHash_key";
ALTER INDEX "TeamInvite_teamId_email_idx" RENAME TO "WorkspaceInvite_workspaceId_email_idx";

ALTER TABLE "Workspace"
  ADD COLUMN "avatarStorageKey" TEXT,
  ADD COLUMN "personalOwnerUserId" UUID,
  ADD COLUMN "status" "WorkspaceStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN "pricingTier" "PricingTier" NOT NULL DEFAULT 'free',
  ADD COLUMN "stripeCustomerId" TEXT,
  ADD COLUMN "stripeSubscriptionId" TEXT,
  ADD COLUMN "stripeSeatItemId" TEXT,
  ADD COLUMN "billingInterval" TEXT,
  ADD COLUMN "billingEventCreatedAt" TIMESTAMP(3),
  ADD COLUMN "subscriptionEndsAt" TIMESTAMP(3),
  ADD COLUMN "defaultBrandTemplateId" UUID;

ALTER TABLE "WorkspaceMember"
  ADD COLUMN "pendingPaymentOperation" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "WorkspaceInvite"
  ADD COLUMN "invitedByUserId" UUID,
  ADD COLUMN "pendingPaymentOperation" TEXT,
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Project"
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "createdByUserId" UUID,
  ADD COLUMN "updatedByUserId" UUID,
  ADD COLUMN "folderId" UUID;

ALTER TABLE "AutopilotRule"
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "createdByUserId" UUID,
  ADD COLUMN "updatedByUserId" UUID;

ALTER TABLE "ApiKey"
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "createdByUserId" UUID;

ALTER TABLE "SocialAccount"
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "createdByUserId" UUID;

DROP INDEX IF EXISTS "SocialAccount_userId_platform_providerAccountId_key";
CREATE UNIQUE INDEX "SocialAccount_workspaceId_platform_providerAccountId_key"
  ON "SocialAccount"("workspaceId", "platform", "providerAccountId");

ALTER TABLE "SocialOAuthState"
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "createdByUserId" UUID;

ALTER TABLE "BrandTemplate"
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "createdByUserId" UUID,
  ADD COLUMN "updatedByUserId" UUID;

ALTER TABLE "AudioAsset"
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "createdByUserId" UUID;

ALTER TABLE "AudioAssetFavorite"
  ADD COLUMN "workspaceId" UUID;

DROP INDEX IF EXISTS "AudioAssetFavorite_userId_assetId_key";
CREATE UNIQUE INDEX "AudioAssetFavorite_workspaceId_assetId_key"
  ON "AudioAssetFavorite"("workspaceId", "assetId");

ALTER TABLE "ClipExport"
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "createdByUserId" UUID;

ALTER TABLE "SocialPost"
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "createdByUserId" UUID;

CREATE TABLE "WorkspaceFolder" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "createdByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceFolder_pkey" PRIMARY KEY ("id")
);

-- Existing dormant teams remain collaborative workspaces. Every user also
-- receives exactly one personal workspace with a stable ownership key.
INSERT INTO "Workspace" (
  "id", "name", "ownerUserId", "personalOwnerUserId", "seatLimit",
  "status", "pricingTier", "billingEventCreatedAt", "stripeCustomerId",
  "defaultBrandTemplateId", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  COALESCE(NULLIF(BTRIM(CONCAT_WS(' ', u."firstName", u."lastName")), ''), 'Personal workspace'),
  u."id",
  u."id",
  1,
  'active'::"WorkspaceStatus",
  CASE WHEN u."pricingTier" = 'starter' THEN 'creator'::"PricingTier" ELSE u."pricingTier" END,
  u."billingEventCreatedAt",
  u."stripeCustomerId",
  u."defaultBrandTemplateId",
  u."createdAt",
  CURRENT_TIMESTAMP
FROM "User" u
WHERE NOT EXISTS (
  SELECT 1 FROM "Workspace" w WHERE w."personalOwnerUserId" = u."id"
);

-- A dormant Team owner may already have an Admin membership. Promote that
-- existing row before inserting missing owner memberships so the unique
-- (workspaceId, userId) key is preserved and the authorization invariant is
-- true for both migrated teams and new personal workspaces.
UPDATE "WorkspaceMember" wm
SET "role" = 'owner'::"WorkspaceRole", "updatedAt" = CURRENT_TIMESTAMP
FROM "Workspace" w
WHERE wm."workspaceId" = w."id" AND wm."userId" = w."ownerUserId";

INSERT INTO "WorkspaceMember" (
  "id", "workspaceId", "userId", "role", "joinedAt", "updatedAt"
)
SELECT gen_random_uuid(), w."id", w."ownerUserId", 'owner'::"WorkspaceRole", w."createdAt", CURRENT_TIMESTAMP
FROM "Workspace" w
WHERE NOT EXISTS (
  SELECT 1 FROM "WorkspaceMember" wm
  WHERE wm."workspaceId" = w."id" AND wm."userId" = w."ownerUserId"
);

UPDATE "Project" r SET
  "workspaceId" = w."id",
  "createdByUserId" = r."userId",
  "updatedByUserId" = r."userId"
FROM "Workspace" w
WHERE w."personalOwnerUserId" = r."userId" AND r."workspaceId" IS NULL;

UPDATE "AutopilotRule" r SET
  "workspaceId" = w."id",
  "createdByUserId" = r."userId",
  "updatedByUserId" = r."userId"
FROM "Workspace" w
WHERE w."personalOwnerUserId" = r."userId" AND r."workspaceId" IS NULL;

UPDATE "ApiKey" r SET "workspaceId" = w."id", "createdByUserId" = r."userId"
FROM "Workspace" w
WHERE w."personalOwnerUserId" = r."userId" AND r."workspaceId" IS NULL;

UPDATE "SocialAccount" r SET "workspaceId" = w."id", "createdByUserId" = r."userId"
FROM "Workspace" w
WHERE w."personalOwnerUserId" = r."userId" AND r."workspaceId" IS NULL;

UPDATE "SocialOAuthState" r SET "workspaceId" = w."id", "createdByUserId" = r."userId"
FROM "Workspace" w
WHERE w."personalOwnerUserId" = r."userId" AND r."workspaceId" IS NULL;

UPDATE "BrandTemplate" r SET
  "workspaceId" = w."id",
  "createdByUserId" = r."userId",
  "updatedByUserId" = r."userId"
FROM "Workspace" w
WHERE w."personalOwnerUserId" = r."userId" AND r."workspaceId" IS NULL;

UPDATE "AudioAsset" r SET "workspaceId" = w."id", "createdByUserId" = r."userId"
FROM "Workspace" w
WHERE w."personalOwnerUserId" = r."userId" AND r."workspaceId" IS NULL;

UPDATE "AudioAssetFavorite" r SET "workspaceId" = w."id"
FROM "Workspace" w
WHERE w."personalOwnerUserId" = r."userId" AND r."workspaceId" IS NULL;

UPDATE "ClipExport" r SET "workspaceId" = p."workspaceId", "createdByUserId" = p."userId"
FROM "Project" p
WHERE p."id" = r."projectId" AND r."workspaceId" IS NULL;

UPDATE "SocialPost" r SET "workspaceId" = p."workspaceId", "createdByUserId" = p."userId"
FROM "Project" p
WHERE p."id" = r."projectId" AND r."workspaceId" IS NULL;

CREATE UNIQUE INDEX "Workspace_personalOwnerUserId_key" ON "Workspace"("personalOwnerUserId");
CREATE UNIQUE INDEX "Workspace_stripeCustomerId_key" ON "Workspace"("stripeCustomerId");
CREATE UNIQUE INDEX "Workspace_stripeSubscriptionId_key" ON "Workspace"("stripeSubscriptionId");
CREATE UNIQUE INDEX "Workspace_stripeSeatItemId_key" ON "Workspace"("stripeSeatItemId");
CREATE INDEX "Workspace_status_pricingTier_idx" ON "Workspace"("status", "pricingTier");
CREATE INDEX "WorkspaceMember_userId_joinedAt_idx" ON "WorkspaceMember"("userId", "joinedAt");
CREATE INDEX "WorkspaceMember_workspaceId_role_idx" ON "WorkspaceMember"("workspaceId", "role");
CREATE INDEX "WorkspaceInvite_workspaceId_expiresAt_idx" ON "WorkspaceInvite"("workspaceId", "expiresAt");
CREATE UNIQUE INDEX "WorkspaceFolder_workspaceId_normalizedName_key" ON "WorkspaceFolder"("workspaceId", "normalizedName");
CREATE INDEX "WorkspaceFolder_workspaceId_createdAt_idx" ON "WorkspaceFolder"("workspaceId", "createdAt");
CREATE INDEX "Project_workspaceId_createdAt_idx" ON "Project"("workspaceId", "createdAt");
CREATE INDEX "Project_workspaceId_ingestStatus_createdAt_idx" ON "Project"("workspaceId", "ingestStatus", "createdAt");
CREATE INDEX "Project_workspaceId_folderId_createdAt_idx" ON "Project"("workspaceId", "folderId", "createdAt");
CREATE INDEX "AutopilotRule_workspaceId_status_createdAt_idx" ON "AutopilotRule"("workspaceId", "status", "createdAt");
CREATE INDEX "ApiKey_workspaceId_revokedAt_idx" ON "ApiKey"("workspaceId", "revokedAt");
CREATE INDEX "SocialAccount_workspaceId_platform_status_idx" ON "SocialAccount"("workspaceId", "platform", "status");
CREATE INDEX "SocialOAuthState_workspaceId_platform_createdAt_idx" ON "SocialOAuthState"("workspaceId", "platform", "createdAt");
CREATE INDEX "BrandTemplate_workspaceId_deletedAt_createdAt_idx" ON "BrandTemplate"("workspaceId", "deletedAt", "createdAt");
CREATE INDEX "AudioAsset_workspaceId_deletedAt_createdAt_idx" ON "AudioAsset"("workspaceId", "deletedAt", "createdAt");
CREATE INDEX "AudioAssetFavorite_workspaceId_createdAt_idx" ON "AudioAssetFavorite"("workspaceId", "createdAt");
CREATE INDEX "ClipExport_workspaceId_createdAt_idx" ON "ClipExport"("workspaceId", "createdAt" DESC);
CREATE INDEX "SocialPost_workspaceId_scheduledFor_idx" ON "SocialPost"("workspaceId", "scheduledFor");

ALTER TABLE "Workspace"
  ADD CONSTRAINT "Workspace_personalOwnerUserId_fkey" FOREIGN KEY ("personalOwnerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Workspace_defaultBrandTemplateId_fkey" FOREIGN KEY ("defaultBrandTemplateId") REFERENCES "BrandTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkspaceFolder" ADD CONSTRAINT "WorkspaceFolder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "WorkspaceFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AutopilotRule" ADD CONSTRAINT "AutopilotRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialOAuthState" ADD CONSTRAINT "SocialOAuthState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandTemplate" ADD CONSTRAINT "BrandTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AudioAssetFavorite" ADD CONSTRAINT "AudioAssetFavorite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipExport" ADD CONSTRAINT "ClipExport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Starter disappears from all newly resolved workspace entitlements. The enum
-- value stays during the compatibility window so old User rows remain readable.
UPDATE "Workspace" SET "pricingTier" = 'creator' WHERE "pricingTier" = 'starter';

-- Fail deployment instead of silently accepting a partial ownership backfill.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User" u
    LEFT JOIN "Workspace" w ON w."personalOwnerUserId" = u."id"
    GROUP BY u."id"
    HAVING COUNT(w."id") <> 1
  ) THEN
    RAISE EXCEPTION 'workspace backfill invariant failed: each user must have exactly one personal workspace';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Workspace" w
    LEFT JOIN "WorkspaceMember" wm
      ON wm."workspaceId" = w."id"
      AND wm."userId" = w."ownerUserId"
      AND wm."role" = 'owner'
    WHERE wm."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'workspace backfill invariant failed: owner membership missing';
  END IF;

  IF EXISTS (SELECT 1 FROM "Project" WHERE "workspaceId" IS NULL)
    OR EXISTS (SELECT 1 FROM "AutopilotRule" WHERE "workspaceId" IS NULL)
    OR EXISTS (SELECT 1 FROM "ApiKey" WHERE "workspaceId" IS NULL)
    OR EXISTS (SELECT 1 FROM "SocialAccount" WHERE "workspaceId" IS NULL)
    OR EXISTS (SELECT 1 FROM "SocialOAuthState" WHERE "workspaceId" IS NULL)
    OR EXISTS (SELECT 1 FROM "BrandTemplate" WHERE "userId" IS NOT NULL AND "workspaceId" IS NULL)
    OR EXISTS (SELECT 1 FROM "AudioAsset" WHERE "userId" IS NOT NULL AND "workspaceId" IS NULL)
    OR EXISTS (SELECT 1 FROM "AudioAssetFavorite" WHERE "workspaceId" IS NULL)
    OR EXISTS (SELECT 1 FROM "ClipExport" WHERE "workspaceId" IS NULL)
    OR EXISTS (SELECT 1 FROM "SocialPost" WHERE "workspaceId" IS NULL)
  THEN
    RAISE EXCEPTION 'workspace backfill invariant failed: owned resources remain unscoped';
  END IF;
END $$;
