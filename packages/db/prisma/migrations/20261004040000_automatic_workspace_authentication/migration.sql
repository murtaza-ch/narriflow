-- Facebook authentication fixtures are obsolete in this pre-production instance.
DELETE FROM "AuthIdentity" WHERE "provider" = 'facebook';

CREATE TYPE "AuthProvider_new" AS ENUM ('google', 'apple', 'microsoft', 'email_password');
ALTER TABLE "AuthIdentity" ALTER COLUMN "provider" TYPE "AuthProvider_new"
  USING ("provider"::text::"AuthProvider_new");
ALTER TYPE "AuthProvider" RENAME TO "AuthProvider_old";
ALTER TYPE "AuthProvider_new" RENAME TO "AuthProvider";
DROP TYPE "AuthProvider_old";

ALTER TABLE "User" DROP COLUMN "onboardingCompletedAt";
