ALTER TABLE "Transcript"
  ADD COLUMN "passagesGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "passagesEpoch" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "passagesSourceHash" TEXT,
  ADD COLUMN "passagesClaimId" UUID,
  ADD COLUMN "passagesLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "passagesDeadlineAt" TIMESTAMP(3),
  ADD CONSTRAINT "Transcript_passages_generation_positive" CHECK ("passagesGeneration" >= 0 AND "passagesEpoch" > 0),
  ADD CONSTRAINT "Transcript_passages_claim_pair" CHECK (("passagesClaimId" IS NULL) = ("passagesLeaseUntil" IS NULL)),
  ADD CONSTRAINT "Transcript_passages_source_hash" CHECK ("passagesSourceHash" IS NULL OR "passagesSourceHash" ~ '^[a-f0-9]{64}$');
