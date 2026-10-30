-- Additive: a new table that current code never reads or writes, so it is safe
-- to apply before the code that uses it deploys.
CREATE TABLE "ClerkDeletedIdentity" (
    "clerkId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClerkDeletedIdentity_pkey" PRIMARY KEY ("clerkId")
);

-- Every soft-deleted App User is a deleted Clerk identity (the only writer of
-- User.deletedAt is the Clerk deletion path).
INSERT INTO "ClerkDeletedIdentity" ("clerkId", "deletedAt")
SELECT "clerkId", "deletedAt" FROM "User" WHERE "deletedAt" IS NOT NULL
ON CONFLICT ("clerkId") DO NOTHING;
