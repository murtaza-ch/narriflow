-- Native OAuth social account storage and account-targeted publishing.

CREATE TYPE "SocialAccountStatus" AS ENUM ('active', 'expired', 'revoked');

CREATE TABLE "SocialAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "handle" TEXT,
    "avatarUrl" TEXT,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SocialOAuthState" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "state" TEXT NOT NULL,
    "codeVerifier" TEXT,
    "redirectPath" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialOAuthState_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SocialPost"
ADD COLUMN "socialAccountId" UUID;

CREATE UNIQUE INDEX "SocialAccount_userId_platform_providerAccountId_key"
ON "SocialAccount"("userId", "platform", "providerAccountId");

CREATE INDEX "SocialAccount_userId_platform_status_idx"
ON "SocialAccount"("userId", "platform", "status");

CREATE INDEX "SocialAccount_status_expiresAt_idx"
ON "SocialAccount"("status", "expiresAt");

CREATE UNIQUE INDEX "SocialOAuthState_state_key"
ON "SocialOAuthState"("state");

CREATE INDEX "SocialOAuthState_userId_platform_createdAt_idx"
ON "SocialOAuthState"("userId", "platform", "createdAt");

CREATE INDEX "SocialOAuthState_expiresAt_idx"
ON "SocialOAuthState"("expiresAt");

CREATE INDEX "SocialPost_socialAccountId_idx"
ON "SocialPost"("socialAccountId");

ALTER TABLE "SocialAccount"
ADD CONSTRAINT "SocialAccount_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialOAuthState"
ADD CONSTRAINT "SocialOAuthState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialPost"
ADD CONSTRAINT "SocialPost_socialAccountId_fkey"
FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
