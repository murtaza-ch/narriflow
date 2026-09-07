DELETE FROM "SocialPost"
WHERE "clientIdempotencyKey" IS NULL
   OR "immutableRequestHash" IS NULL;

ALTER TABLE "SocialPost"
ALTER COLUMN "clientIdempotencyKey" SET NOT NULL,
ALTER COLUMN "immutableRequestHash" SET NOT NULL;

ALTER TABLE "SocialPublicationAttempt"
ADD COLUMN "phaseStartedAt" TIMESTAMP(3),
ADD COLUMN "failureEvidence" JSONB;

UPDATE "SocialPublicationAttempt"
SET "phaseStartedAt" = "startedAt";

ALTER TABLE "SocialPublicationAttempt"
ALTER COLUMN "phaseStartedAt" SET NOT NULL,
ALTER COLUMN "phaseStartedAt" SET DEFAULT CURRENT_TIMESTAMP;
