ALTER TABLE "SocialPublicationAttempt"
  ADD COLUMN "operationLookupHash" TEXT;

CREATE UNIQUE INDEX "SocialPublicationAttempt_operationLookupHash_key"
  ON "SocialPublicationAttempt"("operationLookupHash");
